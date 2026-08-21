import { z } from "zod";

const help = `Usage: bun run scripts/ensure-r2-cors-disabled.ts

Deletes the CORS configuration from both production R2 buckets. Terraform
invokes this helper because Cloudflare rejects an explicit empty CORS policy.

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

const responseSchema = z.object({
  errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]),
  success: z.boolean(),
});

async function deleteCors(url: URL, token: string): Promise<void> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = responseSchema.parse(await response.json());
  const isAlreadyEmpty = body.errors.some(({ code }) => code === 10059);
  if ((!response.ok || !body.success) && !isAlreadyEmpty) {
    const detail = body.errors.map(({ code, message }) => `${code}: ${message}`).join(", ");
    throw new Error(`Cloudflare R2 CORS deletion failed (${response.status}): ${detail}`);
  }
}

async function main(): Promise<void> {
  const environment = environmentSchema.parse(Bun.env);
  const origin = `${environment.CLOUDFLARE_API_ORIGIN.replace(/\/$/, "")}/`;
  for (const bucket of ["drop-control", "drop-content"] as const) {
    await deleteCors(
      new URL(
        `accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/cors`,
        origin,
      ),
      environment.CLOUDFLARE_API_TOKEN,
    );
  }
  console.log("R2 CORS is disabled for drop-control and drop-content");
}

await main();
