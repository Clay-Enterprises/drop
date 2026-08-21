import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { onePixelPng } from "../fixtures.ts";
import {
  createdUploadKeySchema,
  type CreatedUploadKey,
} from "../../src/shared/upload-keys.ts";
import {
  startWorkerd,
  testAdminKey,
  type WorkerdServer,
} from "../workerd.ts";

interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runCli(
  apiUrl: string,
  arguments_: string[],
  environment: Record<string, string | undefined> = {},
  cwd = process.cwd(),
): Promise<CliResult> {
  const process = Bun.spawn(
    ["bun", "run", resolve("src/cli/index.ts"), ...arguments_],
    {
      cwd,
      env: {
        ...Bun.env,
        DROP_ADMIN_KEY: testAdminKey,
        DROP_API_URL: apiUrl,
        ...environment,
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function createUploadKey(
  workerd: WorkerdServer,
): Promise<CreatedUploadKey> {
  const response = await fetch(`${workerd.url}/api/admin/keys`, {
    headers: { authorization: `Bearer ${testAdminKey}` },
    method: "POST",
  });
  return createdUploadKeySchema.parse(await response.json());
}

async function createDrop(
  workerd: WorkerdServer,
  owner: CreatedUploadKey,
  kind: "doc" | "file",
  retention: "7d" | "30d" | "90d" | "keep",
): Promise<{ readonly url: string }> {
  const filename = kind === "doc" ? "report.html" : "pixel.png";
  const response = await fetch(`${workerd.url}/api/${kind}s`, {
    body:
      kind === "doc"
        ? "<!doctype html><title>Admin inventory</title>"
        : onePixelPng,
    headers: {
      authorization: `Bearer ${owner.key}`,
      "content-disposition": `inline; filename="${filename}"`,
      "drop-retention": retention,
    },
    method: "POST",
  });
  return (await response.json()) as { readonly url: string };
}

describe("drop admin content", () => {
  let workerd: WorkerdServer;
  const temporaryDirectories: string[] = [];

  beforeAll(async () => {
    workerd = await startWorkerd();
  });

  afterAll(async () => {
    await workerd.stop();
    await Promise.all(
      temporaryDirectories.map((path) =>
        rm(path, { force: true, recursive: true }),
      ),
    );
  });

  test("lists both Files and Docs as JSON", async () => {
    const owner = await createUploadKey(workerd);
    const file = await createDrop(workerd, owner, "file", "7d");
    const doc = await createDrop(workerd, owner, "doc", "keep");

    const result = await runCli(workerd.url, ["admin", "list", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const body = JSON.parse(result.stdout) as {
      readonly drops: ReadonlyArray<{ readonly url: string }>;
    };
    expect(body.drops.map(({ url }) => url)).toEqual(
      expect.arrayContaining([file.url, doc.url]),
    );
  });

  test("follows every inventory cursor", async () => {
    const requestedPaths: string[] = [];
    const owner = "0123456789abcdef0123456789abcdef";
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requestedPaths.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/api/docs") {
          return Response.json({ drops: [], cursor: null });
        }
        const suffix = url.searchParams.has("cursor") ? "second" : "first";
        return Response.json({
          drops: [
            {
              url: `${url.origin}/files/${suffix === "first" ? "a".repeat(32) : "b".repeat(32)}`,
              kind: "file",
              retention: "keep",
              owner,
              uploadedAt: "2026-08-20T12:00:00.000Z",
              expiresAt: null,
              size: 1,
              contentType: "image/png",
              originalFilename: `${suffix}.png`,
            },
          ],
          cursor: suffix === "first" ? "next-page" : null,
        });
      },
    });
    try {
      const result = await runCli(server.url.href, [
        "admin",
        "list",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      expect(
        (JSON.parse(result.stdout) as { drops: unknown[] }).drops,
      ).toHaveLength(2);
      expect(requestedPaths).toContain("/api/files?cursor=next-page");
    } finally {
      await server.stop(true);
    }
  });

  test("compares time filters as instants instead of ISO text", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        return Response.json({
          drops:
            url.pathname === "/api/files"
              ? [
                  {
                    url: `${url.origin}/files/${"c".repeat(32)}`,
                    kind: "file",
                    retention: "keep",
                    owner: "0123456789abcdef0123456789abcdef",
                    uploadedAt: "2026-08-20T12:00:00.500Z",
                    expiresAt: null,
                    size: 1,
                    contentType: "image/png",
                    originalFilename: "fractional.png",
                  },
                ]
              : [],
          cursor: null,
        });
      },
    });
    try {
      const result = await runCli(server.url.href, [
        "admin",
        "list",
        "--before",
        "2026-08-20T12:00:00Z",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ drops: [] });
    } finally {
      await server.stop(true);
    }
  });

  test("filters inventory locally by kind, Retention Class, owner, and time", async () => {
    const owner = await createUploadKey(workerd);
    const file = await createDrop(workerd, owner, "file", "90d");
    await Bun.sleep(10);
    const doc = await createDrop(workerd, owner, "doc", "30d");
    const inventory = await runCli(workerd.url, ["admin", "list", "--json"]);
    const entries = (
      JSON.parse(inventory.stdout) as {
        drops: Array<{ uploadedAt: string; url: string }>;
      }
    ).drops;
    const fileUploadedAt = entries.find(({ url }) => url === file.url)?.uploadedAt;
    const docUploadedAt = entries.find(({ url }) => url === doc.url)?.uploadedAt;
    if (fileUploadedAt === undefined || docUploadedAt === undefined) {
      throw new Error("Expected both Drops in inventory");
    }

    const cases = [
      [["--kind", "doc"], (drop: Record<string, unknown>) => drop.kind === "doc"],
      [
        ["--retention", "90d"],
        (drop: Record<string, unknown>) => drop.retention === "90d",
      ],
      [
        ["--owner", owner.credentialId],
        (drop: Record<string, unknown>) => drop.owner === owner.credentialId,
      ],
      [
        ["--after", fileUploadedAt],
        (drop: Record<string, unknown>) =>
          typeof drop.uploadedAt === "string" && drop.uploadedAt > fileUploadedAt,
      ],
      [
        ["--before", docUploadedAt],
        (drop: Record<string, unknown>) =>
          typeof drop.uploadedAt === "string" && drop.uploadedAt < docUploadedAt,
      ],
    ] as const;

    for (const [filterArguments, matches] of cases) {
      const result = await runCli(workerd.url, [
        "admin",
        "list",
        ...filterArguments,
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const drops = (JSON.parse(result.stdout) as { drops: Record<string, unknown>[] })
        .drops;
      expect(drops.length).toBeGreaterThan(0);
      expect(drops.every(matches)).toBe(true);
    }
  });

  test("deletes an exact URL and replaces its stale local binding on the next drop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drop-cli-admin-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "pixel.png");
    await writeFile(path, onePixelPng);
    const owner = await createUploadKey(workerd);
    const environment = {
      DROP_UPLOAD_KEY: owner.key,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_STATE_HOME: join(directory, "state"),
    };
    const createdResult = await runCli(
      workerd.url,
      [path, "--json"],
      environment,
      directory,
    );
    const created = JSON.parse(createdResult.stdout) as { url: string };

    const deleted = await runCli(
      workerd.url,
      ["admin", "delete", created.url],
      environment,
      directory,
    );

    expect(deleted).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect((await fetch(created.url)).status).toBe(404);

    const nextResult = await runCli(
      workerd.url,
      [path, "--json"],
      environment,
      directory,
    );
    expect(nextResult.exitCode).toBe(0);
    const next = JSON.parse(nextResult.stdout) as { url: string };
    expect(next.url).not.toBe(created.url);
    expect((await fetch(next.url)).status).toBe(200);
    expect((await fetch(created.url)).status).toBe(404);

    const thirdResult = await runCli(
      workerd.url,
      [path, "--json"],
      environment,
      directory,
    );
    expect(thirdResult.exitCode).toBe(0);
    expect((JSON.parse(thirdResult.stdout) as { url: string }).url).toBe(
      next.url,
    );
  });
});
