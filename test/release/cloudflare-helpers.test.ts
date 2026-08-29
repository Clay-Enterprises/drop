import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const accountId = "6e0cccdd787599d868ec17156c8d372f";

test("R2 CORS helper deletes policies and accepts missing configuration", async () => {
  const deleted: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      expect(request.method).toBe("DELETE");
      expect(request.headers.get("authorization")).toBe("Bearer test-secret");
      const bucket = url.pathname.split("/").at(-2) ?? "";
      deleted.push(bucket);
      return bucket === "drop-control"
        ? Response.json({ errors: [], result: null, success: true })
        : Response.json(
            {
              errors: [{ code: 10059, message: "The CORS configuration does not exist." }],
              result: null,
              success: false,
            },
            { status: 404 },
          );
    },
  });

  try {
    const process = Bun.spawn(
      ["bun", "run", "scripts/ensure-r2-cors-disabled.ts"],
      {
        env: {
          ...Bun.env,
          CLOUDFLARE_ACCOUNT_ID: accountId,
          CLOUDFLARE_API_ORIGIN: server.url.toString(),
          CLOUDFLARE_API_TOKEN: "test-secret",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(await process.exited).toBe(0);
    expect(deleted).toEqual(["drop-control", "drop-content"]);
  } finally {
    server.stop(true);
  }
});

test("control-bucket helper removes every custom domain", async () => {
  const removed: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      expect(request.headers.get("authorization")).toBe("Bearer test-secret");
      if (request.method === "GET") {
        return Response.json({
          errors: [],
          result: {
            domains: [{ domain: "private.example.com" }, { domain: "old.example.com" }],
          },
          success: true,
        });
      }
      removed.push(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
      return Response.json({ errors: [], result: null, success: true });
    },
  });

  try {
    const process = Bun.spawn(
      ["bun", "run", "scripts/ensure-control-bucket-private.ts"],
      {
        env: {
          ...Bun.env,
          CLOUDFLARE_ACCOUNT_ID: accountId,
          CLOUDFLARE_API_ORIGIN: server.url.toString(),
          CLOUDFLARE_API_TOKEN: "test-secret",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(await process.exited).toBe(0);
    expect(removed).toEqual(["private.example.com", "old.example.com"]);
  } finally {
    server.stop(true);
  }
});

test("workers.dev helper leaves an existing account subdomain alone", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests += 1;
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe("Bearer test-secret");
      return Response.json({
        errors: [],
        result: { subdomain: "personal-domains-6e0" },
        success: true,
      });
    },
  });

  try {
    const process = Bun.spawn(
      ["bun", "run", "scripts/ensure-workers-subdomain.ts"],
      {
        env: {
          ...Bun.env,
          CLOUDFLARE_ACCOUNT_ID: accountId,
          CLOUDFLARE_API_ORIGIN: server.url.toString(),
          CLOUDFLARE_API_TOKEN: "test-secret",
          WORKERS_SUBDOMAIN: "personal-domains-6e0",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const stdout = await new Response(process.stdout).text();
    const stderr = await new Response(process.stderr).text();
    expect(await process.exited).toBe(0);
    expect(requests).toBe(1);
    expect(stdout).toContain("personal-domains-6e0");
    expect(`${stdout}${stderr}`).not.toContain("test-secret");
  } finally {
    server.stop(true);
  }
});

test("R2 verification token helper creates scoped credentials and revokes them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drop-r2-token-"));
  const envFile = join(directory, "r2.env");
  const tokenId = "1".repeat(32);
  const tokenValue = "verification-token-value-that-is-long-enough-to-hash";
  let createdPolicy: unknown;
  let revoked = false;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      expect(request.headers.get("authorization")).toBe("Bearer test-secret");
      if (url.pathname.endsWith("/tokens/permission_groups")) {
        return Response.json({
          errors: [],
          result: [
            {
              id: "permission-id",
              name: "Workers R2 Storage Bucket Item Write",
              scopes: ["com.cloudflare.edge.r2.bucket"],
            },
          ],
          success: true,
        });
      }
      if (url.pathname.endsWith("/tokens") && request.method === "POST") {
        createdPolicy = await request.json();
        const expiresOn = (createdPolicy as { expires_on?: unknown }).expires_on;
        if (
          typeof expiresOn !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiresOn)
        ) {
          return Response.json(
            {
              errors: [
                {
                  code: 400,
                  message:
                    'expires_on must be a valid date/time in the format "2005-12-30T01:02:03Z"',
                },
              ],
              result: null,
              success: false,
            },
            { status: 400 },
          );
        }
        return Response.json({
          errors: [],
          result: { id: tokenId, value: tokenValue },
          success: true,
        });
      }
      if (url.pathname.endsWith(`/tokens/${tokenId}`) && request.method === "DELETE") {
        revoked = true;
        return Response.json({ errors: [], result: { id: tokenId }, success: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const environment = {
    ...Bun.env,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_ORIGIN: server.url.toString(),
    CLOUDFLARE_API_TOKEN: "test-secret",
  };

  try {
    const creation = Bun.spawn(
      ["bun", "run", "scripts/r2-verification-token.ts", "create", envFile],
      { env: environment, stderr: "pipe", stdout: "pipe" },
    );
    const createOutput = await new Response(creation.stdout).text();
    const createError = await new Response(creation.stderr).text();
    expect(await creation.exited).toBe(0);
    expect(`${createOutput}${createError}`).not.toContain(tokenValue);
    if (process.platform !== "win32") {
      expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(envFile, "utf8")).toBe(
      `R2_ACCESS_KEY_ID=${tokenId}\n` +
        `R2_SECRET_ACCESS_KEY=${createHash("sha256").update(tokenValue).digest("hex")}\n` +
        `R2_TOKEN_ID=${tokenId}\n`,
    );
    expect(createdPolicy).toMatchObject({
      policies: [
        {
          permission_groups: [{ id: "permission-id" }],
          resources: {
            [`com.cloudflare.edge.r2.bucket.${accountId}_default_drop-content`]: "*",
          },
        },
      ],
    });

    const revocation = Bun.spawn(
      ["bun", "run", "scripts/r2-verification-token.ts", "revoke", tokenId],
      { env: environment, stderr: "pipe", stdout: "pipe" },
    );
    expect(await revocation.exited).toBe(0);
    expect(revoked).toBe(true);
  } finally {
    server.stop(true);
    await rm(directory, { force: true, recursive: true });
  }
});
