import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("release documentation covers the public product and its limits", async () => {
  const license = await readFile(resolve("LICENSE"), "utf8");
  expect(license).toStartWith("MIT License\n");
  expect(license).toContain("Copyright (c) 2026 Clay Enterprises");

  const manifest = JSON.parse(
    await readFile(resolve("package.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(manifest.license).toBe("MIT");

  const readme = (await readFile(resolve("README.md"), "utf8")).toLowerCase();
  for (const required of [
    "curl",
    "drop auth set",
    "drop admin list",
    "drop retention",
    "post /api/files",
    "post /api/docs",
    "7d",
    "30d",
    "90d",
    "keep",
    "95 mib",
    "512 kib",
    "jpeg",
    "webm",
    "r2",
    "class a",
    "class b",
    "egress",
    "no sla",
    "install.sh",
    "install.ps1",
    "sha256sums",
  ]) {
    expect(readme).toContain(required);
  }

  const security = (await readFile(resolve("SECURITY.md"), "utf8")).toLowerCase();
  for (const required of [
    "unlisted url",
    "not secrets",
    "upload key",
    "admin key",
    "responsible disclosure",
    "security advisory",
  ]) {
    expect(security).toContain(required);
  }
});
