import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("production bootstrap commands are safe to inspect without Cloudflare access", async () => {
  const manifest = JSON.parse(
    await readFile(resolve("package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };

  expect(manifest.scripts?.bootstrap).toBe("bash scripts/bootstrap.sh");
  expect(manifest.scripts?.provision).toBe("bash scripts/bootstrap.sh");
  expect(manifest.scripts?.["verify:production"]).toBe(
    "bash scripts/bootstrap.sh --verify",
  );
  expect(manifest.scripts?.dev).toBe(
    "wrangler dev --host 127.0.0.1:8787",
  );

  const syntax = Bun.spawnSync(["bash", "-n", "scripts/bootstrap.sh"]);
  expect(syntax.exitCode).toBe(0);

  const bootstrap = await readFile(
    resolve("scripts/bootstrap.sh"),
    "utf8",
  );
  expect(bootstrap.indexOf('stage "Production confirmation"')).toBeLessThan(
    bootstrap.indexOf(
      '(( ACCEPTANCE_STATUS == 0 )) || fail "Live acceptance failed."',
    ),
  );

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

  const verifier = await readFile(
    resolve("scripts/verify-production.ts"),
    "utf8",
  );
  expect(verifier).toContain('apiFetch("/api/admin/sweep"');
  expect(verifier).not.toContain("wrangler");
  expect(verifier).not.toContain("* * * * *");
});

test("Terraform owns production infrastructure and Wrangler owns Worker code", async () => {
  const config = JSON.parse(
    await readFile(resolve("wrangler.jsonc"), "utf8"),
  ) as {
    observability?: {
      enabled?: boolean;
      logs?: { head_sampling_rate?: number; invocation_logs?: boolean };
    };
    routes?: unknown;
    triggers?: unknown;
    workers_dev?: boolean;
  };
  const terraform = await readFile(
    resolve("infra/terraform/main.tf"),
    "utf8",
  );

  expect(config.workers_dev).toBe(false);
  expect(config.routes).toBeUndefined();
  expect(config.triggers).toBeUndefined();
  expect(config.observability).toEqual({
    enabled: true,
    logs: { head_sampling_rate: 1, invocation_logs: false },
  });
  expect(terraform).toContain('resource "cloudflare_workers_route" "api"');
  expect(terraform).toContain('pattern = "drop.clay.sh/api/*"');
  expect(terraform).toContain('resource "cloudflare_workers_cron_trigger" "expiry"');
  expect(terraform).toContain('{ cron = "0 0 * * *" }');
  expect(terraform).toContain('resource "cloudflare_ruleset" "public_cache"');
  expect(terraform).toContain('resource "cloudflare_ruleset" "public_headers"');
  expect(terraform).not.toContain('resource "cloudflare_r2_bucket_cors"');
  expect(terraform).toContain('resource "terraform_data" "r2_cors"');
  expect(terraform).toContain('data "cloudflare_rulesets" "zone"');
});
