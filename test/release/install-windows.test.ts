import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

async function runPowerShell(
  script: string,
  environment: Record<string, string>,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(["pwsh", "-NoProfile", "-File", script], {
    env: { ...Bun.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

test("PowerShell installer rejects unsupported architectures before writing", async () => {
  if (process.platform !== "win32") return;

  const directory = await mkdtemp(join(tmpdir(), "drop-install-windows-"));
  try {
    const installDirectory = join(directory, "installed");
    const result = await runPowerShell(resolve("install.ps1"), {
      DROP_INSTALL_DIR: installDirectory,
      PROCESSOR_ARCHITECTURE: "ARM64",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unsupported architecture: ARM64.");
    expect(await pathExists(installDirectory)).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("PowerShell installer verifies and installs the Windows release asset", async () => {
  if (process.platform !== "win32") return;

  const directory = await mkdtemp(join(tmpdir(), "drop-install-windows-"));
  try {
    const fixturesDirectory = join(directory, "fixtures");
    const installDirectory = join(directory, "installed");
    await mkdir(fixturesDirectory);

    const assetName = "drop-windows-x64.exe";
    const binary = new TextEncoder().encode("drop 0.1.0\r\n");
    await writeFile(join(fixturesDirectory, assetName), binary);
    await writeFile(
      join(fixturesDirectory, "SHA256SUMS"),
      `${"0".repeat(64)}  ${assetName}\n`,
    );

    const wrapper = join(directory, "install-test.ps1");
    const installer = resolve("install.ps1").replaceAll("'", "''");
    await writeFile(
      wrapper,
      `function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile)
  Copy-Item (Join-Path $env:DROP_TEST_FIXTURES (Split-Path $Uri -Leaf)) $OutFile
}
& '${installer}'
exit $LASTEXITCODE
`,
    );

    const environment = {
      DROP_INSTALL_DIR: installDirectory,
      DROP_TEST_FIXTURES: fixturesDirectory,
      PROCESSOR_ARCHITECTURE: "AMD64",
    };
    const rejected = await runPowerShell(wrapper, environment);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain(
      `Checksum verification failed for ${assetName}.`,
    );
    expect(await pathExists(installDirectory)).toBe(false);

    await writeFile(
      join(fixturesDirectory, "SHA256SUMS"),
      `${await sha256Hex(binary)}  ${assetName}\n`,
    );
    const result = await runPowerShell(wrapper, environment);
    const installedPath = join(installDirectory, "drop.exe");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Installed drop v0.1.0 to ${installedPath}`);
    expect(new Uint8Array(await readFile(installedPath))).toEqual(binary);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
