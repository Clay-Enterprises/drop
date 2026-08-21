import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("production bootstrap accepts empty CORS and an active custom domain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drop-bootstrap-"));
  const fakeBin = join(directory, "bin");
  await mkdir(fakeBin);
  const bunx = join(fakeBin, "bunx");
  await writeFile(
    bunx,
    `#!/usr/bin/env bash
case "$*" in
  "wrangler whoami --json") exit 0 ;;
  "wrangler whoami --account "*" --json") exit 0 ;;
  "wrangler r2 bucket info drop-control"|"wrangler r2 bucket info drop-content") exit 0 ;;
  "wrangler r2 bucket cors list "*)
    printf 'The CORS configuration does not exist. [code: 10059]\\n' >&2
    exit 1
    ;;
  "wrangler r2 bucket dev-url disable "*) exit 0 ;;
  "wrangler r2 bucket domain list drop-control")
    printf 'There are no custom domains connected to this bucket.\\n'
    ;;
  "wrangler r2 bucket domain list drop-content")
    printf 'domain:            drop.clay.sh\\n'
    ;;
  "wrangler r2 bucket domain get drop-content --domain drop.clay.sh")
    printf '%s\\n' \\
      'domain:            drop.clay.sh' \\
      'enabled:           Yes' \\
      'ownership_status:  active' \\
      'ssl_status:        active'
    ;;
  "wrangler deploy --secrets-file "*)
    printf 'reached worker deployment\\n'
    exit 71
    ;;
  *) printf 'unexpected bunx call: %s\\n' "$*" >&2; exit 72 ;;
esac
`,
  );
  await chmod(bunx, 0o700);
  const bun = join(fakeBin, "bun");
  await writeFile(
    bun,
    `#!/usr/bin/env bash
printf 'drop_a_%064d' 0
`,
  );
  await chmod(bun, 0o700);
  for (const command of ["curl", "open", "sleep"]) {
    const executable = join(fakeBin, command);
    await writeFile(executable, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(executable, 0o700);
  }

  try {
    const process = Bun.spawn(["bash", "scripts/bootstrap.sh"], {
      env: {
        ...Bun.env,
        PATH: `${fakeBin}:${Bun.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: directory,
      },
      stdin: "pipe",
      stderr: "pipe",
      stdout: "pipe",
    });
    process.stdin.write(`\n${"a".repeat(32)}\n${"b".repeat(32)}\ny\ny\n`);
    process.stdin.end();
    const stdout = await new Response(process.stdout).text();
    await process.exited;

    expect(stdout).toContain("reached worker deployment");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

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
});
