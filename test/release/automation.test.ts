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
  expect(release).toContain("workflow_call:");
  expect(release).toMatch(/publish:\s+needs: build/);
  for (const [target, asset, runner] of [
    ["bun-darwin-arm64", "drop-darwin-arm64", "macos-15"],
    ["bun-darwin-x64-baseline", "drop-darwin-x64", "macos-15-intel"],
    ["bun-linux-arm64", "drop-linux-arm64", "ubuntu-24.04-arm"],
    ["bun-linux-x64-baseline", "drop-linux-x64", "ubuntu-latest"],
    ["bun-windows-x64-baseline", "drop-windows-x64.exe", "windows-latest"],
  ]) {
    expect(release).toContain(`target: ${target}`);
    expect(release).toContain(`asset: ${asset}`);
    expect(release).toContain(`runner: ${runner}`);
  }
  expect(release).toContain("./dist/${{ matrix.asset }} --version");
  expect(release).toContain("./dist/${{ matrix.asset }} --help");
  expect(release).toContain('& "./dist/${{ matrix.asset }}" --version');
  expect(release).toContain('& "./dist/${{ matrix.asset }}" --help');
  expect(release).toContain("sha256sum drop-*");
  expect(release).toContain("SHA256SUMS");
  expect(release).toContain("install.sh");
  expect(release).toContain("install.ps1");
  expect(release).toContain("gh release create");
  expect(release).toContain('--target "$GITHUB_SHA"');
  expect(release).not.toMatch(/npm publish|packages: write/i);
});

test("accepted main checks deploy the production Worker", async () => {
  const checks = await readWorkflow("checks.yml");

  expect(checks).toContain("deploy-production:");
  expect(checks).toContain(
    "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
  );
  for (const requiredJob of [
    "typecheck",
    "bun-tests",
    "worker-integration",
    "skill-smoke",
    "release-startup",
  ]) {
    expect(checks).toContain(`      - ${requiredJob}`);
  }
  expect(checks).toContain("group: drop-production");
  expect(checks).toContain(
    "CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
  );
  expect(checks).toContain(
    "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
  );
  expect(checks).toContain("run: bun run deploy");
});

test("accepted CLI changes publish the package version once", async () => {
  const checks = await readWorkflow("checks.yml");

  expect(checks).toContain("prepare-cli-release:");
  expect(checks).toContain("group: ${{ github.workflow }}-${{ github.ref }}");
  expect(checks).toContain("git describe --tags --match 'v[0-9]*' --abbrev=0");
  expect(checks).toContain("src/cli src/shared install.sh install.ps1");
  expect(checks).toContain(
    "CLI code changed, but $tag already exists. Bump package.json version.",
  );
  expect(checks).toContain("uses: ./.github/workflows/release.yml");
  expect(checks).toContain("tag: ${{ needs.prepare-cli-release.outputs.tag }}");
});
