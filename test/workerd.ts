import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const testAdminKey = "drop_a_test_admin_secret";

export interface WorkerdServer {
  readonly url: string;
  readControlObject(key: string): Promise<unknown>;
  stop(): Promise<void>;
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

  for (let attempt = 0; attempt < 100; attempt += 1) {
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
          process.kill();
          await process.exited;
          await Promise.all([stdout, stderr]);
          await rm(persistencePath, { force: true, recursive: true });
        },
      };
    } catch {
      await Bun.sleep(50);
    }
  }

  process.kill();
  await process.exited;
  throw new Error(`wrangler did not become ready\n${await stdout}\n${await stderr}`);
}
