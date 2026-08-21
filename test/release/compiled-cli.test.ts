import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createdUploadKeySchema } from "../../src/shared/upload-keys.ts";
import { onePixelPng } from "../fixtures.ts";
import { startWorkerd, testAdminKey } from "../workerd.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runExecutable(
  executable: string,
  arguments_: string[],
  environment: Record<string, string>,
  stdin = "",
): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...arguments_], {
    env: { ...Bun.env, ...environment },
    stdin: "pipe",
    stderr: "pipe",
    stdout: "pipe",
  });
  child.stdin.write(stdin);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

test("compiled release binary authenticates and drops a File", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drop-release-cli-"));
  const workerd = await startWorkerd();
  try {
    const executable = join(
      directory,
      process.platform === "win32" ? "drop.exe" : "drop",
    );
    const build = Bun.spawn(
      [process.execPath, "run", "build:release", `--outfile=${executable}`],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [buildExitCode] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
      new Response(build.stdout).text(),
    ]);
    expect(buildExitCode).toBe(0);

    const environment = {
      DROP_API_URL: workerd.url,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_STATE_HOME: join(directory, "state"),
    };
    expect(await runExecutable(executable, ["--version"], environment)).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "drop 0.1.0\n",
    });
    expect((await runExecutable(executable, ["--help"], environment)).stdout).toContain(
      "drop auth set",
    );

    const keyResponse = await fetch(`${workerd.url}/api/admin/keys`, {
      headers: { authorization: `Bearer ${testAdminKey}` },
      method: "POST",
    });
    const uploadKey = createdUploadKeySchema.parse(await keyResponse.json());
    expect(
      await runExecutable(executable, ["auth", "set"], environment, uploadKey.key),
    ).toEqual({ exitCode: 0, stderr: "Upload Key saved.\n", stdout: "" });

    const configurationPath = join(directory, "config", "drop", "config.json");
    expect(JSON.parse(await readFile(configurationPath, "utf8"))).toEqual({
      uploadKey: uploadKey.key,
    });
    if (process.platform !== "win32") {
      expect((await stat(configurationPath)).mode & 0o777).toBe(0o600);
    }

    const filePath = join(directory, "pixel.png");
    await writeFile(filePath, onePixelPng);
    const dropped = await runExecutable(executable, [filePath], environment);
    expect(dropped.exitCode).toBe(0);
    expect(dropped.stderr).toBe("");
    const url = dropped.stdout.trim();
    expect(url).toMatch(new RegExp(`^${workerd.url}/files/[A-Za-z0-9_-]{32}$`));
    expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(
      onePixelPng,
    );
  } finally {
    await workerd.stop();
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
