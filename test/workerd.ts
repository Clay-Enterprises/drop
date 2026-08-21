import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const testAdminKey = "drop_a_test_admin_secret";

export interface WorkerdServer {
  readonly url: string;
  readControlObject(key: string): Promise<unknown>;
  stop(): Promise<void>;
}

const readinessTimeoutMs = 20_000;

async function stopProcessTree(subprocess: Bun.Subprocess): Promise<void> {
  if (process.platform === "win32") {
    const taskkill = Bun.spawn(
      ["taskkill", "/pid", String(subprocess.pid), "/t", "/f"],
      { stderr: "pipe", stdout: "ignore" },
    );
    const [exitCode, error] = await Promise.all([
      taskkill.exited,
      new Response(taskkill.stderr).text(),
    ]);
    if (exitCode !== 0 && subprocess.exitCode === null) {
      throw new Error(`Failed to stop wrangler\n${error}`);
    }
  } else {
    subprocess.kill();
  }

  await subprocess.exited;
}

export async function startWorkerd(): Promise<WorkerdServer> {
  const portProbe = Bun.serve({
    port: 0,
    fetch: () => new Response(null, { status: 204 }),
  });
  const port = portProbe.port;
  await portProbe.stop(true);

  const persistencePath = await mkdtemp(join(tmpdir(), "drop-workerd-"));
  const process = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "dev",
      "test/worker-entry.ts",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persistencePath,
      "--test-scheduled",
      "--var",
      `ADMIN_KEY:${testAdminKey}`,
      "--log-level",
      "error",
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const stdout = new Response(process.stdout).text();
  const stderr = new Response(process.stderr).text();
  const url = `http://127.0.0.1:${port}`;

  const readinessDeadline = performance.now() + readinessTimeoutMs;
  while (performance.now() < readinessDeadline) {
    if (process.exitCode !== null) {
      throw new Error(
        `wrangler exited before becoming ready\n${await stdout}\n${await stderr}`,
      );
    }

    try {
      await fetch(url);
      return {
        url,
        async readControlObject(key) {
          const command = Bun.spawn(
            [
              "bunx",
              "wrangler",
              "r2",
              "object",
              "get",
              `drop-control/${key}`,
              "--pipe",
              "--local",
              "--persist-to",
              persistencePath,
            ],
            { stderr: "pipe", stdout: "pipe" },
          );
          const [exitCode, output, commandError] = await Promise.all([
            command.exited,
            new Response(command.stdout).text(),
            new Response(command.stderr).text(),
          ]);
          if (exitCode !== 0) {
            throw new Error(`Failed to read control object\n${commandError}`);
          }
          return JSON.parse(output);
        },
        async stop() {
          await stopProcessTree(process);
          await Promise.all([stdout, stderr]);
          await rm(persistencePath, {
            force: true,
            maxRetries: 10,
            recursive: true,
            retryDelay: 100,
          });
        },
      };
    } catch {
      await Bun.sleep(50);
    }
  }

  await stopProcessTree(process);
  throw new Error(`wrangler did not become ready\n${await stdout}\n${await stderr}`);
}
