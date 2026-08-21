import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function sha256Hex(contents: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", contents);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

test("Unix installer rejects unsupported platforms before writing", async () => {
  if (process.platform === "win32") return;

  const directory = await mkdtemp(join(tmpdir(), "drop-install-unix-"));
  try {
    const binDirectory = join(directory, "bin");
    await mkdir(binDirectory);
    const uname = join(binDirectory, "uname");
    await writeFile(
      uname,
      '#!/bin/sh\nif [ "$1" = "-s" ]; then echo FreeBSD; else echo x86_64; fi\n',
    );
    await chmod(uname, 0o755);

    const installDirectory = join(directory, "installed");
    const child = Bun.spawn(["sh", resolve("install.sh")], {
      env: {
        ...Bun.env,
        DROP_INSTALL_DIR: installDirectory,
        PATH: `${binDirectory}${delimiter}${Bun.env.PATH ?? ""}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Unsupported platform: FreeBSD x86_64.\n");
    expect(await pathExists(installDirectory)).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("Unix installer verifies and installs the selected release asset", async () => {
  if (process.platform === "win32") return;

  const directory = await mkdtemp(join(tmpdir(), "drop-install-unix-"));
  try {
    const binDirectory = join(directory, "bin");
    const fixturesDirectory = join(directory, "fixtures");
    const installDirectory = join(directory, "installed");
    await Promise.all([mkdir(binDirectory), mkdir(fixturesDirectory)]);

    const uname = join(binDirectory, "uname");
    await writeFile(
      uname,
      '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo arm64; fi\n',
    );
    await chmod(uname, 0o755);

    const curl = join(binDirectory, "curl");
    await writeFile(
      curl,
      `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    output=$2
    shift 2
  else
    url=$1
    shift
  fi
done
cp "$DROP_TEST_FIXTURES/\${url##*/}" "$output"
`,
    );
    await chmod(curl, 0o755);

    const assetName = "drop-darwin-arm64";
    const binary = new TextEncoder().encode("#!/bin/sh\necho drop 0.1.0\n");
    await writeFile(join(fixturesDirectory, assetName), binary);
    await writeFile(
      join(fixturesDirectory, "SHA256SUMS"),
      `${"0".repeat(64)}  ${assetName}\n`,
    );

    const runInstaller = async () => {
      const child = Bun.spawn(["sh", resolve("install.sh")], {
        env: {
          ...Bun.env,
          DROP_INSTALL_DIR: installDirectory,
          DROP_TEST_FIXTURES: fixturesDirectory,
          PATH: `${binDirectory}${delimiter}${Bun.env.PATH ?? ""}`,
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stderr, stdout };
    };

    expect(await runInstaller()).toEqual({
      exitCode: 1,
      stderr: `Checksum verification failed for ${assetName}.\n`,
      stdout: "",
    });
    expect(await pathExists(installDirectory)).toBe(false);

    await writeFile(
      join(fixturesDirectory, "SHA256SUMS"),
      `${await sha256Hex(binary)}  ${assetName}\n`,
    );
    const { exitCode, stdout, stderr } = await runInstaller();

    const installedPath = join(installDirectory, "drop");
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(`Installed drop v0.1.0 to ${installedPath}\n`);
    expect(new Uint8Array(await readFile(installedPath))).toEqual(binary);
    expect((await stat(installedPath)).mode & 0o111).not.toBe(0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
