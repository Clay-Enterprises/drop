import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runCli(arguments_: string[]): Promise<CommandResult> {
  const child = Bun.spawn(
    [process.execPath, "run", resolve("src/cli/index.ts"), ...arguments_],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("release CLI", () => {
  test("prints the tagged release version", async () => {
    expect(await runCli(["--version"])).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "drop 0.1.1\n",
    });
  });

  test("pins private package metadata to the tagged release", async () => {
    const manifest = JSON.parse(
      await readFile(resolve("package.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest.version).toBe("0.1.1");
    expect(manifest.private).toBe(true);
    expect(manifest.publishConfig).toBeUndefined();
  });

  test("prints help for every public command", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const command of [
      "drop <path>",
      "drop retention <path-or-url> <retention>",
      "drop update",
      "drop auth set",
      "drop admin list",
      "drop admin delete <url>",
      "drop admin keys create",
      "drop admin keys list",
      "drop admin keys revoke <credential-id>",
    ]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toContain("DROP_UPLOAD_KEY");
    expect(result.stdout).toContain("DROP_ADMIN_KEY");
    expect(result.stdout).toContain("DROP_API_URL");
    expect(result.stdout).toContain("DROP_INSTALL_DIR");
    expect(result.stdout).toContain("XDG_BIN_HOME");
    expect(result.stdout).toContain("XDG_CONFIG_HOME");
    expect(result.stdout).toContain("XDG_STATE_HOME");
  });

  test("refuses to replace the Bun runtime during source execution", async () => {
    expect(await runCli(["update"])).toEqual({
      exitCode: 1,
      stderr:
        "error: Run the standalone Drop binary to update it. Source executions cannot update Bun.\n",
      stdout: "",
    });
  });
});
