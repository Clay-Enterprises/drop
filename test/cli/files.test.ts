import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
    readonly environment?: Record<string, string | undefined>;
    readonly stdin?: string;
  },
): Promise<CliResult> {
  const environment: Record<string, string | undefined> = {
    ...Bun.env,
    DROP_API_URL: workerd.url,
    DROP_UPLOAD_KEY: undefined,
    XDG_CONFIG_HOME: join(options.cwd, "config"),
    XDG_STATE_HOME: join(options.cwd, "state"),
    ...options.environment,
  };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete environment[name];
    }
  }

  const process = Bun.spawn(
    ["bun", "run", resolve("src/cli/index.ts"), ...arguments_],
    {
      cwd: options.cwd,
      env: environment,
      stdin: "pipe",
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  process.stdin.write(options.stdin ?? "");
  process.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("drop File", () => {
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
    const path = await mkdtemp(join(tmpdir(), "drop-cli-files-"));
    temporaryDirectories.push(path);
    return path;
  }

  test("prints only the URL and writes a credential-free path binding", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "pixel.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);

    const result = await runCli(workerd, ["pixel.png"], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: uploadKey.key },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(
      new RegExp(`^${workerd.url}/files/[A-Za-z0-9_-]{32}\\n$`),
    );
    const url = result.stdout.trim();
    const publicResponse = await fetch(url);
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(
      onePixelPng,
    );

    const bindingsPath = join(directory, "state", "drop", "bindings");
    const entries = await readdir(bindingsPath);
    expect(entries).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.json$/)]);
    const bindingText = await readFile(join(bindingsPath, entries[0] ?? ""), "utf8");
    expect(JSON.parse(bindingText)).toEqual({
      path: join(await realpath(directory), "pixel.png"),
      url,
      kind: "file",
      etag: expect.stringMatching(/^"[^"]+"$/),
      retention: "keep",
    });
    expect(bindingText).not.toContain(uploadKey.key);
    expect(bindingText).not.toContain(uploadKey.credentialId);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  test("prints the complete response as JSON", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "pixel.png"), onePixelPng);
    const uploadKey = await createUploadKey(workerd);

    const result = await runCli(workerd, ["pixel.png", "--json"], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: uploadKey.key },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      url: expect.stringMatching(
        new RegExp(`^${workerd.url}/files/[A-Za-z0-9_-]{32}$`),
      ),
      kind: "file",
      contentType: "image/png",
      size: onePixelPng.byteLength,
      retention: "keep",
      expiresAt: null,
      etag: expect.stringMatching(/^"[^"]+"$/),
    });
  });

  test("stores a mode-0600 Upload Key and lets the environment override it", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "stored.png"), onePixelPng);
    await writeFile(join(directory, "override.png"), onePixelPng);
    const storedKey = await createUploadKey(workerd);

    const configured = await runCli(workerd, ["auth", "set"], {
      cwd: directory,
      stdin: `${storedKey.key}\n`,
    });
    expect(configured).toEqual({
      exitCode: 0,
      stderr: "Upload Key saved.\n",
      stdout: "",
    });

    const configurationPath = join(directory, "config", "drop", "config.json");
    expect(JSON.parse(await readFile(configurationPath, "utf8"))).toEqual({
      uploadKey: storedKey.key,
    });
    expect((await stat(configurationPath)).mode & 0o777).toBe(0o600);

    const fromConfiguration = await runCli(workerd, ["stored.png"], {
      cwd: directory,
    });
    expect(fromConfiguration.exitCode).toBe(0);
    expect(fromConfiguration.stdout).toContain("/files/");

    await fetch(`${workerd.url}/api/admin/keys/${storedKey.credentialId}`, {
      headers: { authorization: `Bearer ${testAdminKey}` },
      method: "DELETE",
    });
    const environmentKey = await createUploadKey(workerd);
    const fromEnvironment = await runCli(workerd, ["override.png"], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: environmentKey.key },
    });
    expect(fromEnvironment.exitCode).toBe(0);
    expect(fromEnvironment.stdout).toContain("/files/");
  });
});
