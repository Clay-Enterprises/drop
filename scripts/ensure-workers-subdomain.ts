import { z } from "zod";

const help = `Usage: bun run scripts/ensure-workers-subdomain.ts

Idempotently registers the account-level workers.dev subdomain required by
Cloudflare cron triggers.

Required environment variables:
  CLOUDFLARE_ACCOUNT_ID  Cloudflare account ID
  CLOUDFLARE_API_TOKEN   Scoped Cloudflare API token
  WORKERS_SUBDOMAIN      Desired account workers.dev name

Optional environment variables:
  CLOUDFLARE_API_ORIGIN  API origin (default: https://api.cloudflare.com/client/v4)
`;

if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
  console.log(help);
  process.exit(0);
}

const environmentSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/),
  CLOUDFLARE_API_ORIGIN: z.url().default("https://api.cloudflare.com/client/v4"),
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  WORKERS_SUBDOMAIN: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
});

const responseSchema = z.object({
  errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]),
  result: z.object({ subdomain: z.string() }).nullable(),
  success: z.boolean(),
});

async function request(
  url: URL,
  token: string,
  init?: RequestInit,
): Promise<z.infer<typeof responseSchema>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = responseSchema.parse(await response.json());
  const isUnregistered =
    !body.success && body.errors.some(({ code }) => code === 10007);
  if ((!response.ok || !body.success) && !isUnregistered) {
    const detail = body.errors.map(({ code, message }) => `${code}: ${message}`).join(", ");
    throw new Error(`Cloudflare workers.dev request failed (${response.status}): ${detail}`);
  }
  return body;
}

async function main(): Promise<void> {
  const environment = environmentSchema.parse(Bun.env);
  const url = new URL(
    `accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`,
    `${environment.CLOUDFLARE_API_ORIGIN.replace(/\/$/, "")}/`,
  );
  const current = await request(url, environment.CLOUDFLARE_API_TOKEN);
  if (current.success && current.result !== null) {
    console.log(`workers.dev account subdomain is registered: ${current.result.subdomain}`);
    return;
  }

  const created = await request(url, environment.CLOUDFLARE_API_TOKEN, {
    method: "PUT",
    body: JSON.stringify({ subdomain: environment.WORKERS_SUBDOMAIN }),
  });
  if (!created.success || created.result === null) {
    throw new Error("Cloudflare did not return the registered workers.dev subdomain.");
  }
  console.log(`workers.dev account subdomain registered: ${created.result.subdomain}`);
}

await main();
