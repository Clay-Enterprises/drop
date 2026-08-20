import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

async function createUploadKey(
  workerd: WorkerdServer,
): Promise<CreatedUploadKey> {
  const response = await fetch(`${workerd.url}/api/admin/keys`, {
    headers: { authorization: `Bearer ${testAdminKey}` },
    method: "POST",
  });
  return createdUploadKeySchema.parse(await response.json());
}

async function runCli(
  workerd: WorkerdServer,
  arguments_: string[],
  options: {
    readonly cwd: string;
    readonly uploadKey: string;
  },
): Promise<CliResult> {
  const process = Bun.spawn(
    ["bun", "run", resolve("src/cli/index.ts"), ...arguments_],
    {
      cwd: options.cwd,
      env: {
        ...Bun.env,
        DROP_API_URL: workerd.url,
        DROP_UPLOAD_KEY: options.uploadKey,
        XDG_CONFIG_HOME: join(options.cwd, "config"),
        XDG_STATE_HOME: join(options.cwd, "state"),
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

describe("drop Doc", () => {
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

  async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "drop-cli-docs-"));
    temporaryDirectories.push(path);
    return path;
  }

  test("treats only case-insensitive .html paths as Docs", async () => {
    const directory = await temporaryDirectory();
    const uploadKey = await createUploadKey(workerd);
    const html = "<!doctype html><title>Communication</title>";
    await writeFile(join(directory, "communication.HTML"), html);
    await writeFile(join(directory, "communication.htm"), html);

    const doc = await runCli(workerd, ["communication.HTML"], {
      cwd: directory,
      uploadKey: uploadKey.key,
    });
    expect(doc).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: expect.stringMatching(
        new RegExp(`^${workerd.url}/docs/[A-Za-z0-9_-]{32}\\n$`),
      ),
    });
    expect(await (await fetch(doc.stdout.trim())).text()).toBe(html);

    const file = await runCli(workerd, ["communication.htm"], {
      cwd: directory,
      uploadKey: uploadKey.key,
    });
    expect(file).toEqual({
      exitCode: 1,
      stderr: "error: The submitted bytes are not a supported File type.\n",
      stdout: "",
    });
  });

  test("Re-drops and changes retention at the Doc's existing URL", async () => {
    const directory = await temporaryDirectory();
    const uploadKey = await createUploadKey(workerd);
    const path = join(directory, "report.html");
    const firstHtml = "<!doctype html><title>First</title><h1>First</h1>";
    await writeFile(path, firstHtml);

    const firstResult = await runCli(
      workerd,
      [path, "--retention", "7d", "--json"],
      { cwd: directory, uploadKey: uploadKey.key },
    );
    expect(firstResult.exitCode).toBe(0);
    const first = JSON.parse(firstResult.stdout) as {
      etag: string;
      kind: string;
      retention: string;
      url: string;
    };
    expect(first).toMatchObject({ kind: "doc", retention: "7d" });

    const secondHtml = "<!doctype html><title>Second</title><h1>Second</h1>";
    await writeFile(path, secondHtml);
    const secondResult = await runCli(workerd, [path, "--json"], {
      cwd: directory,
      uploadKey: uploadKey.key,
    });
    expect(secondResult.exitCode).toBe(0);
    const second = JSON.parse(secondResult.stdout) as {
      etag: string;
      retention: string;
      url: string;
    };
    expect(second).toMatchObject({ url: first.url, retention: "7d" });
    expect(second.etag).not.toBe(first.etag);
    expect(await (await fetch(first.url)).text()).toBe(secondHtml);

    const retentionResult = await runCli(
      workerd,
      ["retention", path, "30d", "--json"],
      { cwd: directory, uploadKey: uploadKey.key },
    );
    expect(retentionResult.exitCode).toBe(0);
    expect(JSON.parse(retentionResult.stdout)).toMatchObject({
      url: first.url,
      kind: "doc",
      retention: "30d",
      etag: expect.stringMatching(/^"[^"]+"$/),
    });
    expect(await (await fetch(first.url)).text()).toBe(secondHtml);

    const bindingsDirectory = join(directory, "state", "drop", "bindings");
    const entries = await readdir(bindingsDirectory);
    expect(entries).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(join(bindingsDirectory, entries[0] ?? ""), "utf8"),
      ),
    ).toMatchObject({
      path: await realpath(path),
      url: first.url,
      kind: "doc",
      retention: "30d",
    });
  });

  test("creates a new Doc URL after Expiry removes the bound Doc", async () => {
    const directory = await temporaryDirectory();
    const uploadKey = await createUploadKey(workerd);
    const path = join(directory, "temporary.html");
    await writeFile(path, "<!doctype html><title>Temporary</title>");
    const firstResult = await runCli(
      workerd,
      [path, "--retention", "7d", "--json"],
      { cwd: directory, uploadKey: uploadKey.key },
    );
    const first = JSON.parse(firstResult.stdout) as { url: string };
    const opaqueId = new URL(first.url).pathname.slice("/docs/".length);
    await fetch(`${workerd.url}/__test/doc-objects/${opaqueId}/expiry`, {
      body: JSON.stringify({ expiresAt: new Date(0).toISOString() }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    await fetch(`${workerd.url}/__scheduled`);
    expect((await fetch(first.url)).status).toBe(404);

    await writeFile(path, "<!doctype html><title>Replacement</title>");
    const nextResult = await runCli(workerd, [path, "--json"], {
      cwd: directory,
      uploadKey: uploadKey.key,
    });

    expect(nextResult.exitCode).toBe(0);
    const next = JSON.parse(nextResult.stdout) as { kind: string; url: string };
    expect(next.kind).toBe("doc");
    expect(next.url).not.toBe(first.url);
    expect((await fetch(next.url)).status).toBe(200);
  });
});
