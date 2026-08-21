import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function readWorkflow(name: string): Promise<string> {
  return readFile(resolve(".github", "workflows", name), "utf8");
}

test("accepted checks gate a checksummed five-platform release", async () => {
  const checks = await readWorkflow("checks.yml");
  for (const required of [
    "workflow_call:",
    "bun run typecheck",
    "bun test test/cli",
    "bun test test/worker",
    "bun test test/skills.test.ts",
    "bun test test/release",
    "ubuntu-24.04-arm",
    "macos-15",
    "macos-15-intel",
    "windows-latest",
  ]) {
    expect(checks).toContain(required);
  }

  const release = await readWorkflow("release.yml");
  expect(release).toContain("uses: ./.github/workflows/checks.yml");
  expect(release).toMatch(/build:\s+needs: checks/);
  expect(release).toMatch(/publish:\s+needs: build/);
  for (const [target, asset] of [
    ["bun-darwin-arm64", "drop-darwin-arm64"],
    ["bun-darwin-x64-baseline", "drop-darwin-x64"],
    ["bun-linux-arm64", "drop-linux-arm64"],
    ["bun-linux-x64-baseline", "drop-linux-x64"],
    ["bun-windows-x64-baseline", "drop-windows-x64.exe"],
  ]) {
    expect(release).toContain(`target: ${target}`);
    expect(release).toContain(`asset: ${asset}`);
  }
  expect(release).toContain("sha256sum drop-*");
  expect(release).toContain("SHA256SUMS");
  expect(release).toContain("install.sh");
  expect(release).toContain("install.ps1");
  expect(release).toContain("gh release create");
  expect(release).not.toMatch(/npm publish|packages: write/i);
});
