import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { releaseAssetName, updateDrop } from "../../src/cli/update.ts";

function releaseFetcher(
  version: string,
  assetName: string,
  assetBytes: Uint8Array,
  checksum = createHash("sha256").update(assetBytes).digest("hex"),
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input) => {
    const url = String(input);
    if (url.includes("/releases/latest")) {
      return Response.json({
        assets: [
          {
            name: assetName,
            browser_download_url: "https://release.test/asset",
          },
          {
            name: "SHA256SUMS",
            browser_download_url: "https://release.test/checksums",
          },
        ],
        draft: false,
        prerelease: false,
        tag_name: `v${version}`,
      });
    }
    if (url === "https://release.test/asset") {
      return new Response(assetBytes);
    }
    if (url === "https://release.test/checksums") {
      return new Response(`${checksum}  ${assetName}\n`);
    }
    return new Response(null, { status: 404 });
  };
}

test("selects the release asset for every supported platform", () => {
  expect(releaseAssetName("darwin", "arm64")).toBe("drop-darwin-arm64");
  expect(releaseAssetName("darwin", "x64")).toBe("drop-darwin-x64");
  expect(releaseAssetName("linux", "arm64")).toBe("drop-linux-arm64");
  expect(releaseAssetName("linux", "x64")).toBe("drop-linux-x64");
  expect(releaseAssetName("win32", "x64")).toBe("drop-windows-x64.exe");
  expect(releaseAssetName("freebsd", "x64")).toBeUndefined();
});

test("skips an automatic release check for one day", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drop-update-"));
  try {
    const executablePath = join(directory, "drop");
    const statePath = join(directory, "update.json");
    await Promise.all([
      writeFile(executablePath, "current", { mode: 0o755 }),
      writeFile(
        statePath,
        `${JSON.stringify({ checkedAt: "2026-08-29T12:00:00.000Z", version: "0.1.1" })}\n`,
      ),
    ]);
    let requests = 0;
    const result = await updateDrop({
      currentVersion: "0.1.1",
      executablePath,
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 500 });
      },
      now: new Date("2026-08-30T11:59:59.999Z"),
      platform: "darwin",
      arch: "arm64",
      statePath,
    });

    expect(result).toEqual({ status: "skipped", reason: "recent" });
    expect(requests).toBe(0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("replaces a standalone executable after verifying its checksum", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "drop-update-"));
  try {
    const executablePath = join(directory, "drop");
    const statePath = join(directory, "state", "update.json");
    const updatedBytes = new TextEncoder().encode("updated-drop");
    await writeFile(executablePath, "old-drop", { mode: 0o751 });

    const result = await updateDrop({
      currentVersion: "0.1.1",
      executablePath,
      fetch: releaseFetcher("0.1.2", "drop-darwin-arm64", updatedBytes),
      force: true,
      now: new Date("2026-08-30T12:00:00.000Z"),
      platform: "darwin",
      arch: "arm64",
      statePath,
    });

    expect(result).toEqual({
      status: "updated",
      from: "0.1.1",
      to: "0.1.2",
      executablePath,
      pendingExit: false,
      relocated: false,
    });
    expect(await readFile(executablePath, "utf8")).toBe("updated-drop");
    expect((await stat(executablePath)).mode & 0o777).toBe(0o751);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      checkedAt: "2026-08-30T12:00:00.000Z",
      version: "0.1.2",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("moves a Nix-managed update to a user-writable executable", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "drop-update-"));
  try {
    const fallbackPath = join(directory, "bin", "drop");
    const statePath = join(directory, "state", "update.json");
    const updatedBytes = new TextEncoder().encode("updated-drop");

    const result = await updateDrop({
      currentVersion: "0.1.1",
      executablePath: "/nix/store/example-drop-0.1.1/bin/drop",
      fallbackPath,
      fetch: releaseFetcher("0.1.2", "drop-darwin-arm64", updatedBytes),
      force: true,
      platform: "darwin",
      arch: "arm64",
      statePath,
    });

    expect(result).toEqual({
      status: "updated",
      from: "0.1.1",
      to: "0.1.2",
      executablePath: fallbackPath,
      pendingExit: false,
      relocated: true,
    });
    expect(await readFile(fallbackPath, "utf8")).toBe("updated-drop");
    expect((await stat(fallbackPath)).mode & 0o777).toBe(0o755);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps the installed executable when the checksum is wrong", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "drop-update-"));
  try {
    const executablePath = join(directory, "drop");
    const statePath = join(directory, "update.json");
    await writeFile(executablePath, "old-drop", { mode: 0o755 });

    await expect(
      updateDrop({
        currentVersion: "0.1.1",
        executablePath,
        fetch: releaseFetcher(
          "0.1.2",
          "drop-darwin-arm64",
          new TextEncoder().encode("tampered"),
          "0".repeat(64),
        ),
        force: true,
        platform: "darwin",
        arch: "arm64",
        statePath,
      }),
    ).rejects.toThrow("checksum does not match");
    expect(await readFile(executablePath, "utf8")).toBe("old-drop");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("an explicit check ignores recent update state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drop-update-"));
  try {
    const executablePath = join(directory, "drop");
    const statePath = join(directory, "update.json");
    await Promise.all([
      writeFile(executablePath, "current", { mode: 0o755 }),
      writeFile(
        statePath,
        `${JSON.stringify({ checkedAt: new Date().toISOString(), version: "0.1.1" })}\n`,
      ),
    ]);
    let requests = 0;
    const fetcher = releaseFetcher(
      "0.1.1",
      "drop-darwin-arm64",
      new TextEncoder().encode("unused"),
    );

    const result = await updateDrop({
      currentVersion: "0.1.1",
      executablePath,
      fetch: async (...arguments_) => {
        requests += 1;
        return fetcher(...arguments_);
      },
      force: true,
      platform: "darwin",
      arch: "arm64",
      statePath,
    });

    expect(result).toEqual({ status: "current", version: "0.1.1" });
    expect(requests).toBe(1);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
