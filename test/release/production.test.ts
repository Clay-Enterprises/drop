import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("production bootstrap commands are safe to inspect without Cloudflare access", async () => {
  const manifest = JSON.parse(
    await readFile(resolve("package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };

  expect(manifest.scripts?.bootstrap).toBe("bash scripts/bootstrap.sh");
  expect(manifest.scripts?.["verify:production"]).toBe(
    "bun run scripts/verify-production.ts",
  );
  expect(manifest.scripts?.dev).toBe(
    "wrangler dev --host 127.0.0.1:8787",
  );

  const syntax = Bun.spawnSync(["bash", "-n", "scripts/bootstrap.sh"]);
  expect(syntax.exitCode).toBe(0);

  const check = Bun.spawnSync(["bash", "scripts/bootstrap.sh", "--check"]);
  expect(check.exitCode).toBe(0);
  expect(check.stdout.toString()).toContain(
    "Production bootstrap checks passed.",
  );

  const help = Bun.spawnSync([
    "bun",
    "run",
    "scripts/verify-production.ts",
    "--help",
  ]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("DROP_ADMIN_KEY");
  expect(help.stdout.toString()).toContain("R2_ACCESS_KEY_ID");
});

test("production deploy uses one route, one cron, and app-only logs", async () => {
  const config = JSON.parse(
    await readFile(resolve("wrangler.jsonc"), "utf8"),
  ) as {
    observability?: {
      enabled?: boolean;
      logs?: { head_sampling_rate?: number; invocation_logs?: boolean };
    };
    routes?: Array<{ pattern?: string; zone_name?: string }>;
    triggers?: { crons?: string[] };
    workers_dev?: boolean;
  };

  expect(config.workers_dev).toBe(false);
  expect(config.routes).toEqual([
    { pattern: "drop.clay.sh/api/*", zone_name: "clay.sh" },
  ]);
  expect(config.triggers?.crons).toEqual(["0 0 * * *"]);
  expect(config.observability).toEqual({
    enabled: true,
    logs: { head_sampling_rate: 1, invocation_logs: false },
  });

  const readme = await readFile(resolve("README.md"), "utf8");
  expect(readme).toContain("bun run bootstrap");
  expect(readme).toContain("bun run verify:production");
  expect(readme).toContain("admin-key");
});
