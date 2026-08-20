import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
  workerd: WorkerdServer,
  arguments_: string[],
  environment: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const process = Bun.spawn(
    ["bun", "run", "src/cli/index.ts", ...arguments_],
    {
      env: {
        ...Bun.env,
        DROP_ADMIN_KEY: testAdminKey,
        DROP_API_URL: workerd.url,
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

describe("drop admin keys", () => {
  let workerd: WorkerdServer;

  beforeAll(async () => {
    workerd = await startWorkerd();
  });

  afterAll(async () => {
    await workerd.stop();
  });

  test("create prints only the new Upload Key", async () => {
    const result = await runCli(workerd, ["admin", "keys", "create"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(
      /^drop_u_[0-9a-f]{32}_[0-9a-f]{64}\n$/,
    );

    const credentialId = result.stdout.slice(7, 39);
    const response = await fetch(`${workerd.url}/api/admin/keys`, {
      headers: { authorization: `Bearer ${testAdminKey}` },
    });
    const body = (await response.json()) as {
      keys: Array<{ credentialId: string; createdAt: string }>;
    };
    expect(body.keys).toContainEqual({
      credentialId,
      createdAt: expect.any(String),
    });
  });

  test("create supports machine-readable JSON", async () => {
    const result = await runCli(workerd, [
      "admin",
      "keys",
      "create",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({
      credentialId: expect.stringMatching(/^[0-9a-f]{32}$/),
      createdAt: expect.any(String),
      key: expect.stringMatching(/^drop_u_[0-9a-f]{32}_[0-9a-f]{64}$/),
    });
  });

  test("list prints stable tab-separated summaries without secrets", async () => {
    await runCli(workerd, ["admin", "keys", "create"]);
    await runCli(workerd, ["admin", "keys", "create"]);

    const result = await runCli(workerd, ["admin", "keys", "list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines).toEqual([...lines].sort());
    for (const line of lines) {
      expect(line).toMatch(
        /^[0-9a-f]{32}\t\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }
    expect(result.stdout).not.toContain("drop_u_");
  });

  test("list supports machine-readable JSON", async () => {
    await runCli(workerd, ["admin", "keys", "create"]);
    const result = await runCli(workerd, [
      "admin",
      "keys",
      "list",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const body = JSON.parse(result.stdout) as {
      keys: Array<Record<string, unknown>>;
    };
    expect(body.keys.length).toBeGreaterThan(0);
    for (const key of body.keys) {
      expect(Object.keys(key).sort()).toEqual(["createdAt", "credentialId"]);
    }
  });

  test("revoke exits silently after deleting the exact Upload Key", async () => {
    const created = await runCli(workerd, ["admin", "keys", "create"]);
    const credentialId = created.stdout.slice(7, 39);

    const result = await runCli(workerd, [
      "admin",
      "keys",
      "revoke",
      credentialId,
    ]);

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    const listed = await runCli(workerd, ["admin", "keys", "list"]);
    expect(listed.stdout).not.toContain(credentialId);
  });

  test("revoke supports machine-readable JSON", async () => {
    const created = await runCli(workerd, ["admin", "keys", "create"]);
    const credentialId = created.stdout.slice(7, 39);

    const result = await runCli(workerd, [
      "admin",
      "keys",
      "revoke",
      credentialId,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ credentialId, revoked: true });
  });

  test("reports authentication failures on stderr with a nonzero exit", async () => {
    const result = await runCli(
      workerd,
      ["admin", "keys", "list"],
      { DROP_ADMIN_KEY: "drop_a_wrong" },
    );

    expect(result).toEqual({
      exitCode: 1,
      stderr: "error: The provided credential is invalid.\n",
      stdout: "",
    });
  });

  test("requires DROP_ADMIN_KEY without making a request", async () => {
    const result = await runCli(
      workerd,
      ["admin", "keys", "list"],
      { DROP_ADMIN_KEY: "" },
    );

    expect(result).toEqual({
      exitCode: 1,
      stderr: "error: DROP_ADMIN_KEY must contain a valid Admin Key.\n",
      stdout: "",
    });
  });

  test("rejects invalid commands with a usage exit", async () => {
    const result = await runCli(workerd, ["admin", "keys"]);

    expect(result).toEqual({
      exitCode: 2,
      stderr:
        "error: Usage: drop admin keys create|list|revoke <credential-id>\n",
      stdout: "",
    });
  });
});
