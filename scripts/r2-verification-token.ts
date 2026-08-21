import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";

import { z } from "zod";

const help = `Usage:
  bun run scripts/r2-verification-token.ts create <env-file>
  bun run scripts/r2-verification-token.ts revoke <token-id>

Creates or revokes the short-lived, drop-content-only S3 credential used by
the live production verifier. The create command writes a mode-0600 env file.

Required environment variables:
  CLOUDFLARE_ACCOUNT_ID  Cloudflare account ID
  CLOUDFLARE_API_TOKEN   Token with Account API Tokens Write

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

const permissionGroupsSchema = z.object({
  errors: z.array(errorSchema).default([]),
  result: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      scopes: z.array(z.string()).default([]),
    }),
  ),
  success: z.literal(true),
});

const createdTokenSchema = z.object({
  errors: z.array(errorSchema).default([]),
  result: z.object({
    id: z.string().regex(/^[0-9a-f]{32}$/),
    value: z.string().min(40),
  }),
  success: z.literal(true),
});

const deletedTokenSchema = z.object({
  errors: z.array(errorSchema).default([]),
  success: z.literal(true),
});

async function cloudflareRequest(
  url: URL,
  token: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ errors: z.array(errorSchema).default([]) }).safeParse(body);
    const detail = parsed.success
      ? parsed.data.errors.map(({ code, message }) => `${code}: ${message}`).join(", ")
      : "invalid API response";
    throw new Error(`Cloudflare token request failed (${response.status}): ${detail}`);
  }
  return body;
}

function accountUrl(environment: z.infer<typeof environmentSchema>, path: string): URL {
  return new URL(
    `accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/${path}`,
    `${environment.CLOUDFLARE_API_ORIGIN.replace(/\/$/, "")}/`,
  );
}

async function create(environment: z.infer<typeof environmentSchema>, output: string): Promise<void> {
  const permissionResponse = await cloudflareRequest(
    accountUrl(
      environment,
      "tokens/permission_groups?name=Workers%20R2%20Storage%20Bucket%20Item%20Write",
    ),
    environment.CLOUDFLARE_API_TOKEN,
  );
  const permissions = permissionGroupsSchema.parse(permissionResponse).result;
  const permission = permissions.find(
    ({ name, scopes }) =>
      name === "Workers R2 Storage Bucket Item Write" &&
      scopes.includes("com.cloudflare.edge.r2.bucket"),
  );
  if (permission === undefined) {
    throw new Error("Cloudflare did not return the R2 bucket-item write permission group.");
  }

  const expiresOn = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
  const tokenResponse = await cloudflareRequest(
    accountUrl(environment, "tokens"),
    environment.CLOUDFLARE_API_TOKEN,
    {
      method: "POST",
      body: JSON.stringify({
        expires_on: expiresOn,
        name: `Drop production verification ${new Date().toISOString()}`,
        policies: [
          {
            effect: "allow",
            permission_groups: [{ id: permission.id }],
            resources: {
              [`com.cloudflare.edge.r2.bucket.${environment.CLOUDFLARE_ACCOUNT_ID}_default_drop-content`]:
                "*",
            },
          },
        ],
      }),
    },
  );
  const created = createdTokenSchema.parse(tokenResponse).result;
  const secret = createHash("sha256").update(created.value).digest("hex");
  await writeFile(
    output,
    `R2_ACCESS_KEY_ID=${created.id}\nR2_SECRET_ACCESS_KEY=${secret}\nR2_TOKEN_ID=${created.id}\n`,
    { mode: 0o600 },
  );
  await chmod(output, 0o600);
  console.log("created short-lived drop-content verification token");
}

async function revoke(
  environment: z.infer<typeof environmentSchema>,
  tokenId: string,
): Promise<void> {
  deletedTokenSchema.parse(
    await cloudflareRequest(
      accountUrl(environment, `tokens/${tokenId}`),
      environment.CLOUDFLARE_API_TOKEN,
      { method: "DELETE" },
    ),
  );
  console.log("revoked short-lived verification token");
}

const environment = environmentSchema.parse(Bun.env);
const [, , command, argument] = Bun.argv;
if (command === "create" && argument !== undefined) {
  await create(environment, argument);
} else if (command === "revoke" && argument?.match(/^[0-9a-f]{32}$/)) {
  await revoke(environment, argument);
} else {
  console.error(help);
  process.exit(1);
}
