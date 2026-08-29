import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

const githubReleaseSchema = z.object({
  assets: z.array(
    z.object({
      browser_download_url: z.url(),
      name: z.string(),
    }),
  ),
  draft: z.boolean(),
  prerelease: z.boolean(),
  tag_name: z.string().regex(/^v\d+\.\d+\.\d+$/),
});

const updateStateSchema = z
  .object({
    checkedAt: z.iso.datetime(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();

const releaseApiUrl =
  "https://api.github.com/repos/Clay-Enterprises/drop/releases/latest";
const updateIntervalMs = 24 * 60 * 60 * 1_000;
const maximumAssetSize = 128 * 1024 * 1024;
const maximumChecksumsSize = 64 * 1024;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type UpdateResult =
  | { readonly status: "current"; readonly version: string }
  | {
      readonly from: string;
      readonly executablePath: string;
      readonly pendingExit: boolean;
      readonly relocated: boolean;
      readonly status: "updated";
      readonly to: string;
    }
  | { readonly reason: "recent" | "source"; readonly status: "skipped" };

export interface UpdateOptions {
  readonly arch?: string;
  readonly currentVersion: string;
  readonly executablePath?: string;
  readonly fallbackPath?: string;
  readonly fetch?: Fetch;
  readonly force?: boolean;
  readonly now?: Date;
  readonly platform?: NodeJS.Platform;
  readonly statePath?: string;
}

function stateRoot(): string {
  const configured = Bun.env.XDG_STATE_HOME;
  return configured === undefined || configured === ""
    ? join(homedir(), ".local", "state")
    : resolve(configured);
}

export function updateStatePath(): string {
  return join(stateRoot(), "drop", "update.json");
}

export function releaseAssetName(
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  if (platform === "darwin" && arch === "arm64") return "drop-darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "drop-darwin-x64";
  if (platform === "linux" && arch === "arm64") return "drop-linux-arm64";
  if (platform === "linux" && arch === "x64") return "drop-linux-x64";
  if (platform === "win32" && arch === "x64") return "drop-windows-x64.exe";
  return undefined;
}

export function standaloneExecutablePath(): string | undefined {
  const executable = resolve(process.execPath);
  const name = basename(executable).toLowerCase();
  return name === "drop" || name === "drop.exe" ? executable : undefined;
}

export function userExecutablePath(
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = Bun.env.DROP_INSTALL_DIR || Bun.env.XDG_BIN_HOME;
  if (configured !== undefined && configured !== "") {
    return join(
      resolve(configured),
      platform === "win32" ? "drop.exe" : "drop",
    );
  }
  if (platform === "win32") {
    const localAppData = Bun.env.LOCALAPPDATA;
    if (localAppData !== undefined && localAppData !== "") {
      return join(resolve(localAppData), "Programs", "drop", "bin", "drop.exe");
    }
  }
  return join(
    homedir(),
    ".local",
    "bin",
    platform === "win32" ? "drop.exe" : "drop",
  );
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function readUpdateState(
  path: string,
): Promise<z.infer<typeof updateStateSchema> | undefined> {
  try {
    return updateStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

async function writeUpdateState(
  path: string,
  value: z.infer<typeof updateStateSchema>,
): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function responseBytes(
  response: Response,
  label: string,
  maximumSize: number,
): Promise<Uint8Array> {
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumSize) {
    throw new Error(`${label} is unexpectedly large.`);
  }
  return bytes;
}

function expectedChecksum(checksums: string, asset: string): string {
  for (const line of checksums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (match?.[2] === asset) return match[1] ?? "";
  }
  throw new Error(`SHA256SUMS does not contain ${asset}.`);
}

async function replaceOnWindows(
  executablePath: string,
  stagedPath: string,
): Promise<void> {
  const helperPath = `${stagedPath}.ps1`;
  const script = `param([int]$ParentId, [string]$StagedPath, [string]$TargetPath, [string]$HelperPath)\nWait-Process -Id $ParentId -ErrorAction SilentlyContinue\nMove-Item -LiteralPath $StagedPath -Destination $TargetPath -Force\nRemove-Item -LiteralPath $HelperPath -Force\n`;
  await writeFile(helperPath, script, { encoding: "utf8", flag: "wx" });
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-File",
      helperPath,
      String(process.pid),
      stagedPath,
      executablePath,
      helperPath,
    ],
    { stderr: "ignore", stdin: "ignore", stdout: "ignore" },
  );
  child.unref();
}

async function installAsset(
  executablePath: string,
  bytes: Uint8Array,
  checksum: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const actualChecksum = createHash("sha256").update(bytes).digest("hex");
  if (actualChecksum !== checksum) {
    throw new Error("The downloaded Drop checksum does not match SHA256SUMS.");
  }

  const directory = dirname(executablePath);
  const stagedPath = join(
    directory,
    `.drop-update-${crypto.randomUUID()}${platform === "win32" ? ".exe" : ""}`,
  );
  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    let mode: number | undefined;
    if (platform !== "win32") {
      try {
        mode = (await stat(executablePath)).mode & 0o777;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
        mode = 0o755;
      }
    }
    await writeFile(stagedPath, bytes, { flag: "wx", mode: 0o755 });
    if (mode !== undefined) await chmod(stagedPath, mode);
    if (platform === "win32") {
      await replaceOnWindows(executablePath, stagedPath);
      return true;
    }
    await rename(stagedPath, executablePath);
    return false;
  } catch (error) {
    await rm(stagedPath, { force: true });
    throw error;
  }
}

function isUnwritable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EACCES" ||
      error.code === "EROFS" ||
      error.code === "EPERM")
  );
}

export async function updateDrop(
  options: UpdateOptions,
): Promise<UpdateResult> {
  const executablePath = options.executablePath ?? standaloneExecutablePath();
  if (executablePath === undefined) {
    return { status: "skipped", reason: "source" };
  }

  const now = options.now ?? new Date();
  const statePath = options.statePath ?? updateStatePath();
  const state = await readUpdateState(statePath);
  if (
    options.force !== true &&
    state !== undefined &&
    now.getTime() - new Date(state.checkedAt).getTime() >= 0 &&
    now.getTime() - new Date(state.checkedAt).getTime() < updateIntervalMs
  ) {
    return { status: "skipped", reason: "recent" };
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const assetName = releaseAssetName(platform, arch);
  if (assetName === undefined) {
    throw new Error(`Drop updates do not support ${platform} ${arch}.`);
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  const releaseResponse = await fetcher(releaseApiUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `drop/${options.currentVersion}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!releaseResponse.ok) {
    throw new Error(
      `The Drop release check returned HTTP ${releaseResponse.status}.`,
    );
  }
  const release = githubReleaseSchema.parse(await releaseResponse.json());
  if (release.draft || release.prerelease) {
    throw new Error(
      "GitHub returned a draft or prerelease as the latest Drop release.",
    );
  }
  const latestVersion = release.tag_name.slice(1);
  if (compareVersions(latestVersion, options.currentVersion) <= 0) {
    await writeUpdateState(statePath, {
      checkedAt: now.toISOString(),
      version: options.currentVersion,
    });
    return { status: "current", version: options.currentVersion };
  }

  const asset = release.assets.find(({ name }) => name === assetName);
  const checksums = release.assets.find(({ name }) => name === "SHA256SUMS");
  if (asset === undefined || checksums === undefined) {
    throw new Error(
      `The latest Drop release is missing ${assetName} or SHA256SUMS.`,
    );
  }
  const [assetBytes, checksumsBytes] = await Promise.all([
    fetcher(asset.browser_download_url, {
      signal: AbortSignal.timeout(60_000),
    }).then((response) => responseBytes(response, assetName, maximumAssetSize)),
    fetcher(checksums.browser_download_url, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) =>
      responseBytes(response, "SHA256SUMS", maximumChecksumsSize),
    ),
  ]);
  const checksum = expectedChecksum(
    new TextDecoder().decode(checksumsBytes),
    assetName,
  );
  let targetPath = executablePath;
  let relocated = false;
  let pendingExit: boolean;
  const fallbackPath = options.fallbackPath ?? userExecutablePath(platform);
  try {
    if (executablePath.startsWith("/nix/store/")) {
      targetPath = fallbackPath;
      relocated = true;
    }
    pendingExit = await installAsset(
      targetPath,
      assetBytes,
      checksum,
      platform,
    );
  } catch (error) {
    if (!relocated && targetPath !== fallbackPath && isUnwritable(error)) {
      targetPath = fallbackPath;
      relocated = true;
      pendingExit = await installAsset(
        targetPath,
        assetBytes,
        checksum,
        platform,
      );
    } else {
      throw error;
    }
  }
  await writeUpdateState(statePath, {
    checkedAt: now.toISOString(),
    version: latestVersion,
  });
  return {
    status: "updated",
    from: options.currentVersion,
    to: latestVersion,
    executablePath: targetPath,
    pendingExit,
    relocated,
  };
}
