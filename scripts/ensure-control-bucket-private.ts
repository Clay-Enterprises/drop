import { z } from "zod";

const help = `Usage: bun run scripts/ensure-control-bucket-private.ts

Removes every R2 custom domain from drop-control so the metadata bucket has no
public origin. Terraform invokes this helper because the Cloudflare provider
cannot represent the absence of R2 custom domains.

Required environment variables:
  CLOUDFLARE_ACCOUNT_ID  Cloudflare account ID
  CLOUDFLARE_API_TOKEN   Scoped Cloudflare API token

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
});

const errorSchema = z.object({ code: z.number(), message: z.string() });
const domainListSchema = z.object({
  errors: z.array(errorSchema).default([]),
  result: z.object({
    domains: z.array(z.object({ domain: z.string().min(1) })),
  }),
  success: z.literal(true),
});
const deletionSchema = z.object({
  errors: z.array(errorSchema).default([]),
  success: z.literal(true),
});

async function request(
  url: URL,
  token: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ errors: z.array(errorSchema).default([]) }).safeParse(body);
    const detail = parsed.success
      ? parsed.data.errors.map(({ code, message }) => `${code}: ${message}`).join(", ")
      : "invalid API response";
    throw new Error(`Cloudflare R2 domain request failed (${response.status}): ${detail}`);
  }
  return body;
}

async function main(): Promise<void> {
  const environment = environmentSchema.parse(Bun.env);
  const url = new URL(
    `accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/drop-control/domains/custom`,
    `${environment.CLOUDFLARE_API_ORIGIN.replace(/\/$/, "")}/`,
  );
  const domains = domainListSchema.parse(
    await request(url, environment.CLOUDFLARE_API_TOKEN),
  ).result.domains;

  for (const { domain } of domains) {
    deletionSchema.parse(
      await request(
        new URL(`${url.toString().replace(/\/$/, "")}/${encodeURIComponent(domain)}`),
        environment.CLOUDFLARE_API_TOKEN,
        { method: "DELETE" },
      ),
    );
  }
  console.log(
    domains.length === 0
      ? "drop-control has no custom domains"
      : `removed ${domains.length} custom domain(s) from drop-control`,
  );
}

await main();
