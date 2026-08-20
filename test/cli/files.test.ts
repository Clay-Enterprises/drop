import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import ffmpegPath from "ffmpeg-static";

import { onePixelGif, onePixelPng } from "../fixtures.ts";
import {
  onePixelAvif,
  onePixelJpeg,
  structuredOnlyMp4,
  tinyMp4,
  tinyWebm,
  wideWebm,
} from "../media-fixtures.ts";
import { maxFileSize } from "../../src/shared/files.ts";
import {
  createdUploadKeySchema,
  type CreatedUploadKey,
} from "../../src/shared/upload-keys.ts";
import {
  startWorkerd,
  testAdminKey,
  type WorkerdServer,
} from "../workerd.ts";

interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function createUploadKey(
  workerd: WorkerdServer,
): Promise<CreatedUploadKey> {
  const response = await fetch(`${workerd.url}/api/admin/keys`, {
    headers: { authorization: `Bearer ${testAdminKey}` },
    method: "POST",
  });
  return createdUploadKeySchema.parse(await response.json());
}

async function runCli(
  workerd: WorkerdServer,
  arguments_: string[],
  options: {
    readonly cwd: string;
    readonly environment?: Record<string, string | undefined>;
    readonly stdin?: string;
  },
): Promise<CliResult> {
  const environment: Record<string, string | undefined> = {
    ...Bun.env,
    DROP_API_URL: workerd.url,
    DROP_UPLOAD_KEY: undefined,
    XDG_CONFIG_HOME: join(options.cwd, "config"),
    XDG_STATE_HOME: join(options.cwd, "state"),
    ...options.environment,
  };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete environment[name];
    }
  }

  const child = Bun.spawn(
    [process.execPath, "run", resolve("src/cli/index.ts"), ...arguments_],
    {
      cwd: options.cwd,
      env: environment,
      stdin: "pipe",
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  child.stdin.write(options.stdin ?? "");
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("drop File", () => {
  let workerd: WorkerdServer;
  const temporaryDirectories: string[] = [];

  beforeAll(async () => {
    workerd = await startWorkerd();
  });

  afterAll(async () => {
    await workerd.stop();
    await Promise.all(
      temporaryDirectories.map((path) =>
        rm(path, { force: true, recursive: true }),
      ),
    );
  });

  async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "drop-cli-files-"));
    temporaryDirectories.push(path);
    return path;
  }

  async function installFakeFfmpeg(
    directory: string,
    output: Uint8Array | "oversized",
  ): Promise<string> {
    const binDirectory = join(directory, "bin");
    await mkdir(binDirectory);
    const executable = join(binDirectory, "ffmpeg");
    const outputStatement =
      output === "oversized"
        ? `await Bun.write(outputPath, new Uint8Array());\ntruncateSync(outputPath, ${maxFileSize + 1});`
        : `await Bun.write(outputPath, Uint8Array.from(atob("${Buffer.from(output).toString("base64")}"), (character) => character.charCodeAt(0)));`;
    await writeFile(
      executable,
      `#!/usr/bin/env bun\nimport { truncateSync } from "node:fs";\nconst outputPath = Bun.argv.at(-1);\nif (outputPath === undefined) process.exit(2);\n${outputStatement}\nconsole.error("frame=1");\nconsole.error("progress=end");\n`,
    );
    await chmod(executable, 0o700);
    return `${binDirectory}${delimiter}${Bun.env.PATH ?? ""}`;
  }

  function installedFfmpegPath(): string {
    if (ffmpegPath === null) throw new Error("ffmpeg-static was not installed");
    return `${dirname(ffmpegPath)}${delimiter}${Bun.env.PATH ?? ""}`;
  }

  test("prints only the URL and writes a credential-free path binding", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "pixel.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);

    const result = await runCli(workerd, ["pixel.png"], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: uploadKey.key },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(
      new RegExp(`^${workerd.url}/files/[A-Za-z0-9_-]{32}\\n$`),
    );
    const url = result.stdout.trim();
    const publicResponse = await fetch(url);
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(
      onePixelPng,
    );

    const bindingsPath = join(directory, "state", "drop", "bindings");
    const entries = await readdir(bindingsPath);
    expect(entries).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.json$/)]);
    const bindingText = await readFile(join(bindingsPath, entries[0] ?? ""), "utf8");
    expect(JSON.parse(bindingText)).toEqual({
      path: join(await realpath(directory), "pixel.png"),
      url,
      kind: "file",
      etag: expect.stringMatching(/^"[^"]+"$/),
      retention: "keep",
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      formatVersion: 1,
    });
    expect(bindingText).not.toContain(uploadKey.key);
    expect(bindingText).not.toContain(uploadKey.credentialId);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  test("Re-drops the same path at its existing URL and updates its binding", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "changing-file");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };

    const first = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });
    expect(first.exitCode).toBe(0);
    const url = first.stdout.trim();
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const bindingFilename = (await readdir(bindingsPath))[0];
    if (bindingFilename === undefined) {
      throw new Error("Expected the first Drop to write a binding");
    }
    const bindingPath = join(bindingsPath, bindingFilename);
    const firstBinding = JSON.parse(await readFile(bindingPath, "utf8")) as {
      etag: string;
    };
    await writeFile(path, onePixelGif);

    const second = await runCli(workerd, [path, "--json"], {
      cwd: directory,
      environment,
    });

    expect(second.exitCode).toBe(0);
    expect(second.stderr).toBe("");
    expect(JSON.parse(second.stdout)).toEqual({
      url,
      kind: "file",
      contentType: "image/gif",
      size: onePixelGif.byteLength,
      retention: "keep",
      expiresAt: null,
      etag: expect.stringMatching(/^"[^"]+"$/),
    });
    const entries = await readdir(bindingsPath);
    expect(entries).toEqual([bindingFilename]);
    const nextBinding = JSON.parse(await readFile(bindingPath, "utf8")) as {
      etag: string;
      url: string;
    };
    expect(nextBinding.url).toBe(url);
    expect(nextBinding.etag).not.toBe(firstBinding.etag);

    const publicResponse = await fetch(url, { cache: "no-store" });
    expect(publicResponse.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(
      onePixelGif,
    );
  });

  test("processes video to an observable fast-start H.264 and AAC MP4", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "clip.webm");
    await writeFile(path, wideWebm);
    const uploadKey = await createUploadKey(workerd);
    expect(new TextDecoder().decode(wideWebm)).toContain("private-title");

    const result = await runCli(workerd, [path], {
      cwd: directory,
      environment: {
        DROP_UPLOAD_KEY: uploadKey.key,
        PATH: installedFfmpegPath(),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      new RegExp(`^${workerd.url}/files/[A-Za-z0-9_-]{32}\\n$`),
    );
    expect(result.stderr).toContain("progress=end");
    expect(result.stdout).not.toContain("progress=");
    const publicResponse = await fetch(result.stdout.trim());
    expect(publicResponse.headers.get("content-type")).toBe("video/mp4");
    const uploaded = new Uint8Array(await publicResponse.arrayBuffer());
    const containerText = new TextDecoder().decode(uploaded);
    expect(containerText).toContain("avc1");
    expect(containerText).toContain("mp4a");
    const movieOffset = containerText.indexOf("moov");
    expect(movieOffset).toBeLessThan(
      containerText.indexOf("mdat"),
    );
    const videoSampleEntry = containerText.indexOf("avc1", movieOffset);
    expect(videoSampleEntry).toBeGreaterThan(movieOffset);
    const width =
      (uploaded[videoSampleEntry + 28]! << 8) |
      uploaded[videoSampleEntry + 29]!;
    const height =
      (uploaded[videoSampleEntry + 30]! << 8) |
      uploaded[videoSampleEntry + 31]!;
    expect({ width, height }).toEqual({ width: 1920, height: 96 });
    expect(containerText).not.toContain("private-title");
  });

  test("Re-drops processed video as unchanged raw WebM at the same URL", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "changing-video.webm");
    await writeFile(path, tinyWebm);
    const uploadKey = await createUploadKey(workerd);
    const environment = {
      DROP_UPLOAD_KEY: uploadKey.key,
      PATH: await installFakeFfmpeg(directory, tinyMp4),
    };
    const processed = await runCli(workerd, [path, "--json"], {
      cwd: directory,
      environment,
    });
    expect(processed.exitCode).toBe(0);
    const first = JSON.parse(processed.stdout) as { etag: string; url: string };

    const raw = await runCli(workerd, [path, "--raw", "--json"], {
      cwd: directory,
      environment,
    });

    expect(raw.exitCode).toBe(0);
    expect(raw.stderr).toBe("");
    expect(JSON.parse(raw.stdout)).toMatchObject({
      url: first.url,
      contentType: "video/webm",
      size: tinyWebm.byteLength,
      etag: expect.not.stringMatching(first.etag),
    });
    const publicResponse = await fetch(first.url, { cache: "no-store" });
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(
      new Uint8Array(tinyWebm),
    );
  });

  test("uploads valid raw MP4 bytes unchanged", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "raw.mp4");
    await writeFile(path, tinyMp4);
    const uploadKey = await createUploadKey(workerd);

    const result = await runCli(workerd, [path, "--raw", "--json"], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: uploadKey.key },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const created = JSON.parse(result.stdout) as {
      contentType: string;
      size: number;
      url: string;
    };
    expect(created).toMatchObject({
      contentType: "video/mp4",
      size: tinyMp4.byteLength,
    });
    expect(new Uint8Array(await (await fetch(created.url)).arrayBuffer())).toEqual(
      new Uint8Array(tinyMp4),
    );
  });

  test("rejects --raw for non-video Files before upload", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "pixel.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const before = (await (
      await fetch(`${workerd.url}/__test/content-objects`)
    ).json()) as { objects: unknown[] };

    const result = await runCli(workerd, [path, "--raw"], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: uploadKey.key },
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: "error: --raw accepts only valid MP4 or WebM Files.\n",
      stdout: "",
    });
    const after = (await (
      await fetch(`${workerd.url}/__test/content-objects`)
    ).json()) as { objects: unknown[] };
    expect(after.objects).toHaveLength(before.objects.length);
  });

  test("rejects a structurally empty MP4 with --raw before upload", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "broken.mp4");
    await writeFile(path, structuredOnlyMp4);
    const uploadKey = await createUploadKey(workerd);

    const result = await runCli(workerd, [path, "--raw"], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: uploadKey.key },
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: "error: --raw accepts only valid MP4 or WebM Files.\n",
      stdout: "",
    });
  });

  test("reports a platform installation hint when FFmpeg is missing", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "clip.webm");
    await writeFile(path, tinyWebm);
    const uploadKey = await createUploadKey(workerd);
    const before = (await (
      await fetch(`${workerd.url}/__test/content-objects`)
    ).json()) as { objects: unknown[] };
    const installationHint =
      process.platform === "darwin"
        ? "Install FFmpeg with Homebrew: brew install ffmpeg."
        : process.platform === "win32"
          ? "Install FFmpeg with winget: winget install Gyan.FFmpeg."
          : "Install FFmpeg with your package manager, for example: sudo apt install ffmpeg.";

    const result = await runCli(workerd, [path], {
      cwd: directory,
      environment: {
        DROP_UPLOAD_KEY: uploadKey.key,
        PATH: join(directory, "empty-bin"),
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: `error: FFmpeg is required to process video. ${installationHint}\n`,
      stdout: "",
    });
    const after = (await (
      await fetch(`${workerd.url}/__test/content-objects`)
    ).json()) as { objects: unknown[] };
    expect(after.objects).toHaveLength(before.objects.length);
  });

  test("rejects raw and processed output above 95 MiB before upload", async () => {
    const directory = await temporaryDirectory();
    const uploadKey = await createUploadKey(workerd);
    const before = (await (
      await fetch(`${workerd.url}/__test/content-objects`)
    ).json()) as { objects: unknown[] };
    const oversizedRawPath = join(directory, "oversized.mp4");
    await writeFile(oversizedRawPath, tinyMp4);
    await truncate(oversizedRawPath, maxFileSize + 1);
    const raw = await runCli(workerd, [oversizedRawPath, "--raw"], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: uploadKey.key },
    });
    expect(raw).toEqual({
      exitCode: 1,
      stderr:
        "error: The resulting File is 99614721 bytes (95.00 MiB), above the 95 MiB limit. Compress it more aggressively and try again.\n",
      stdout: "",
    });

    const videoPath = join(directory, "processed.webm");
    await writeFile(videoPath, tinyWebm);
    const processed = await runCli(workerd, [videoPath], {
      cwd: directory,
      environment: {
        DROP_UPLOAD_KEY: uploadKey.key,
        PATH: await installFakeFfmpeg(directory, "oversized"),
      },
    });
    expect(processed).toEqual({
      exitCode: 1,
      stderr:
        "frame=1\nprogress=end\nerror: The resulting File is 99614721 bytes (95.00 MiB), above the 95 MiB limit. Compress it more aggressively and try again.\n",
      stdout: "",
    });
    const after = (await (
      await fetch(`${workerd.url}/__test/content-objects`)
    ).json()) as { objects: unknown[] };
    expect(after.objects).toHaveLength(before.objects.length);
  });

  test("processes a source above 95 MiB when its result fits", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "large-source.mp4");
    const source = new Uint8Array(tinyMp4);
    const mediaDataType = new TextDecoder().decode(source).lastIndexOf("mdat");
    source.fill(0, mediaDataType - 4, mediaDataType);
    await writeFile(path, source);
    await truncate(path, maxFileSize + 1);
    const uploadKey = await createUploadKey(workerd);

    const result = await runCli(workerd, [path, "--json"], {
      cwd: directory,
      environment: {
        DROP_UPLOAD_KEY: uploadKey.key,
        PATH: await installFakeFfmpeg(directory, tinyMp4),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      contentType: "video/mp4",
      size: tinyMp4.byteLength,
    });
  });

  test("Re-drops alternate image types unchanged with detected type changes", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "changing-image");
    await writeFile(path, onePixelJpeg);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const first = await runCli(workerd, [path, "--json"], {
      cwd: directory,
      environment,
    });
    expect(first.exitCode).toBe(0);
    const created = JSON.parse(first.stdout) as { etag: string; url: string };
    await writeFile(path, onePixelAvif);

    const second = await runCli(workerd, [path, "--json"], {
      cwd: directory,
      environment,
    });

    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      url: created.url,
      contentType: "image/avif",
      size: onePixelAvif.byteLength,
      etag: expect.not.stringMatching(created.etag),
    });
    expect(new Uint8Array(await (await fetch(created.url)).arrayBuffer())).toEqual(
      new Uint8Array(onePixelAvif),
    );
  });

  test("upgrades a binding written before checksums were added", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "legacy-binding.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const first = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });
    expect(first.exitCode).toBe(0);
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const bindingFilename = (await readdir(bindingsPath))[0];
    if (bindingFilename === undefined) {
      throw new Error("Expected the first Drop to write a binding");
    }
    const bindingPath = join(bindingsPath, bindingFilename);
    const legacyBinding = JSON.parse(
      await readFile(bindingPath, "utf8"),
    ) as Record<string, unknown>;
    delete legacyBinding.checksum;
    delete legacyBinding.formatVersion;
    await writeFile(bindingPath, `${JSON.stringify(legacyBinding)}\n`);
    await writeFile(path, onePixelGif);

    const result = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(first.stdout);
    expect(JSON.parse(await readFile(bindingPath, "utf8"))).toMatchObject({
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      formatVersion: 1,
      url: first.stdout.trim(),
    });
  });

  test("does not replace an unverifiable legacy binding after a 404", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "legacy-missing.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const first = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });
    expect(first.exitCode).toBe(0);
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const bindingFilename = (await readdir(bindingsPath))[0];
    if (bindingFilename === undefined) {
      throw new Error("Expected the first Drop to write a binding");
    }
    const bindingPath = join(bindingsPath, bindingFilename);
    const legacyBinding = JSON.parse(
      await readFile(bindingPath, "utf8"),
    ) as Record<string, unknown>;
    delete legacyBinding.checksum;
    delete legacyBinding.formatVersion;
    const url = String(legacyBinding.url);
    legacyBinding.url = `${url.slice(0, -1)}${url.endsWith("A") ? "B" : "A"}`;
    await writeFile(bindingPath, `${JSON.stringify(legacyBinding)}\n`);

    const result = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr:
        `error: The legacy local binding could not be verified: ${await realpath(path)}\n`,
      stdout: "",
    });
    expect((await fetch(first.stdout.trim())).status).toBe(200);
  });

  test("fails explicitly when the path binding is corrupt", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "corrupt.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const first = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });
    expect(first.exitCode).toBe(0);
    const before = (await (
      await fetch(`${workerd.url}/__test/content-objects`)
    ).json()) as { objects: unknown[] };
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const bindingFilename = (await readdir(bindingsPath))[0];
    if (bindingFilename === undefined) {
      throw new Error("Expected the first Drop to write a binding");
    }
    await writeFile(join(bindingsPath, bindingFilename), "not json\n");
    await writeFile(path, onePixelGif);

    const result = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: `error: The local binding for this path is corrupt: ${await realpath(path)}\n`,
      stdout: "",
    });
    const after = (await (
      await fetch(`${workerd.url}/__test/content-objects`)
    ).json()) as { objects: unknown[] };
    expect(after.objects).toHaveLength(before.objects.length);
    const publicResponse = await fetch(first.stdout.trim());
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(
      onePixelPng,
    );
  });

  test("detects a valid-looking Opaque ID corrupted in a binding", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "plausibly-corrupt.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const first = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });
    expect(first.exitCode).toBe(0);
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const bindingFilename = (await readdir(bindingsPath))[0];
    if (bindingFilename === undefined) {
      throw new Error("Expected the first Drop to write a binding");
    }
    const bindingPath = join(bindingsPath, bindingFilename);
    const binding = JSON.parse(await readFile(bindingPath, "utf8")) as {
      url: string;
    };
    const lastCharacter = binding.url.at(-1);
    binding.url = `${binding.url.slice(0, -1)}${lastCharacter === "A" ? "B" : "A"}`;
    await writeFile(bindingPath, `${JSON.stringify(binding)}\n`);

    const result = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: `error: The local binding for this path is corrupt: ${await realpath(path)}\n`,
      stdout: "",
    });
    expect((await fetch(first.stdout.trim())).status).toBe(200);
  });

  test("does not move a bound File when DROP_API_URL changes", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "bound-server.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const first = await runCli(workerd, [path], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: uploadKey.key },
    });
    expect(first.exitCode).toBe(0);
    await writeFile(path, onePixelGif);

    const result = await runCli(workerd, [path], {
      cwd: directory,
      environment: {
        DROP_API_URL: "http://127.0.0.1:1",
        DROP_UPLOAD_KEY: uploadKey.key,
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr:
        `error: The local binding belongs to ${workerd.url}, not http://127.0.0.1:1.\n`,
      stdout: "",
    });
    const publicResponse = await fetch(first.stdout.trim());
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(
      onePixelPng,
    );
  });

  test("creates a new Drop after a File moves to another absolute path", async () => {
    const directory = await temporaryDirectory();
    const originalPath = join(directory, "original.png");
    const movedPath = join(directory, "moved.png");
    await writeFile(originalPath, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const first = await runCli(workerd, [originalPath], {
      cwd: directory,
      environment,
    });
    expect(first.exitCode).toBe(0);
    await rename(originalPath, movedPath);

    const moved = await runCli(workerd, [movedPath], {
      cwd: directory,
      environment,
    });

    expect(moved.exitCode).toBe(0);
    expect(moved.stdout).toMatch(
      new RegExp(`^${workerd.url}/files/[A-Za-z0-9_-]{32}\\n$`),
    );
    expect(moved.stdout).not.toBe(first.stdout);
    expect(
      await readdir(join(directory, "state", "drop", "bindings")),
    ).toHaveLength(2);
    expect((await fetch(first.stdout.trim())).status).toBe(200);
    expect((await fetch(moved.stdout.trim())).status).toBe(200);
  });

  test("replaces a stale binding when its remote File is missing", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "missing.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const first = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });
    expect(first.exitCode).toBe(0);
    const oldUrl = first.stdout.trim();
    const opaqueId = new URL(oldUrl).pathname.slice("/files/".length);
    const deleted = await fetch(
      `${workerd.url}/__test/content-objects/${opaqueId}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);
    expect((await fetch(oldUrl)).status).toBe(404);
    await writeFile(path, onePixelGif);

    const replacement = await runCli(workerd, [path, "--json"], {
      cwd: directory,
      environment,
    });

    expect(replacement.exitCode).toBe(0);
    const body = JSON.parse(replacement.stdout) as {
      contentType: string;
      url: string;
    };
    expect(body.contentType).toBe("image/gif");
    expect(body.url).not.toBe(oldUrl);
    expect((await fetch(oldUrl)).status).toBe(404);
    expect((await fetch(body.url)).status).toBe(200);

    const bindingsPath = join(directory, "state", "drop", "bindings");
    const entries = await readdir(bindingsPath);
    expect(entries).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(bindingsPath, entries[0] ?? ""), "utf8")),
    ).toMatchObject({ url: body.url });
  });

  test("creates a new Drop when expiry wins a concurrent Re-drop race", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "expiring.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const created = await runCli(
      workerd,
      [path, "--retention", "7d", "--json"],
      { cwd: directory, environment },
    );
    expect(created.exitCode).toBe(0);
    const first = JSON.parse(created.stdout) as { url: string };
    const opaqueId = new URL(first.url).pathname.slice("/files/".length);
    await fetch(`${workerd.url}/__test/content-objects/${opaqueId}/expiry`, {
      body: JSON.stringify({ expiresAt: new Date(0).toISOString() }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    await fetch(`${workerd.url}/__test/expiry-race`, {
      body: JSON.stringify({ opaqueId, pause: "after-tombstone" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const scheduled = await fetch(`${workerd.url}/__scheduled`);
    const paused = await fetch(`${workerd.url}/__test/expiry-race/wait`);
    expect(scheduled.status).toBe(200);
    expect(paused.status).toBe(204);
    await writeFile(path, onePixelGif);

    const replacement = await runCli(workerd, [path, "--json"], {
      cwd: directory,
      environment,
    });
    const released = await fetch(`${workerd.url}/__test/expiry-race/release`, {
      method: "POST",
    });

    expect(released.status).toBe(204);
    expect(replacement.exitCode).toBe(0);
    const next = JSON.parse(replacement.stdout) as {
      contentType: string;
      url: string;
    };
    expect(next).toMatchObject({ contentType: "image/gif" });
    expect(next.url).not.toBe(first.url);
    expect((await fetch(first.url)).status).toBe(404);
    expect((await fetch(next.url)).status).toBe(200);
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const entries = await readdir(bindingsPath);
    expect(entries).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(bindingsPath, entries[0] ?? ""), "utf8")),
    ).toMatchObject({ url: next.url });
  });

  test("keeps unrelated concurrent path bindings independently", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "first.png"), onePixelPng);
    await writeFile(join(directory, "second.gif"), onePixelGif);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };

    const [first, second] = await Promise.all([
      runCli(workerd, ["first.png"], {
        cwd: directory,
        environment,
      }),
      runCli(workerd, ["second.gif"], {
        cwd: directory,
        environment,
      }),
    ]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).not.toBe(second.stdout);
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const entries = await readdir(bindingsPath);
    expect(entries).toHaveLength(2);
    const bindings = await Promise.all(
      entries.map(async (entry) =>
        JSON.parse(await readFile(join(bindingsPath, entry), "utf8")),
      ),
    );
    expect(bindings.map(({ path }) => path).sort()).toEqual([
      await realpath(join(directory, "first.png")),
      await realpath(join(directory, "second.gif")),
    ]);
  });

  test("does not replace a File owned by another Upload Key", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "owned.png");
    await writeFile(path, onePixelPng);
    const owner = await createUploadKey(workerd);
    const first = await runCli(workerd, [path], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: owner.key },
    });
    expect(first.exitCode).toBe(0);
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const bindingFilename = (await readdir(bindingsPath))[0];
    if (bindingFilename === undefined) {
      throw new Error("Expected the first Drop to write a binding");
    }
    const bindingPath = join(bindingsPath, bindingFilename);
    const originalBinding = await readFile(bindingPath, "utf8");
    await writeFile(path, onePixelGif);
    const otherKey = await createUploadKey(workerd);

    const result = await runCli(workerd, [path], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: otherKey.key },
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: "error: This Upload Key did not create the File.\n",
      stdout: "",
    });
    expect(await readFile(bindingPath, "utf8")).toBe(originalBinding);
    const publicResponse = await fetch(first.stdout.trim());
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(
      onePixelPng,
    );
  });

  test("does not Re-drop after the owning Upload Key is revoked", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "revoked.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const first = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });
    expect(first.exitCode).toBe(0);
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const bindingFilename = (await readdir(bindingsPath))[0];
    if (bindingFilename === undefined) {
      throw new Error("Expected the first Drop to write a binding");
    }
    const bindingPath = join(bindingsPath, bindingFilename);
    const originalBinding = await readFile(bindingPath, "utf8");
    await fetch(`${workerd.url}/api/admin/keys/${uploadKey.credentialId}`, {
      headers: { authorization: `Bearer ${testAdminKey}` },
      method: "DELETE",
    });
    await writeFile(path, onePixelGif);

    const result = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: "error: The provided credential is invalid.\n",
      stdout: "",
    });
    expect(await readFile(bindingPath, "utf8")).toBe(originalBinding);
    const publicResponse = await fetch(first.stdout.trim());
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(
      onePixelPng,
    );
  });

  test("does not overwrite a File after its binding ETag becomes stale", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "stale.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const first = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });
    expect(first.exitCode).toBe(0);
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const bindingFilename = (await readdir(bindingsPath))[0];
    if (bindingFilename === undefined) {
      throw new Error("Expected the first Drop to write a binding");
    }
    const bindingPath = join(bindingsPath, bindingFilename);
    const originalBindingText = await readFile(bindingPath, "utf8");
    const binding = JSON.parse(originalBindingText) as {
      etag: string;
      url: string;
    };
    const opaqueId = new URL(binding.url).pathname.slice("/files/".length);
    const concurrent = await fetch(`${workerd.url}/api/files/${opaqueId}`, {
      body: onePixelGif,
      headers: {
        authorization: `Bearer ${uploadKey.key}`,
        "content-disposition": 'inline; filename="concurrent.gif"',
        "if-match": binding.etag,
      },
      method: "PUT",
    });
    expect(concurrent.status).toBe(200);

    const result = await runCli(workerd, [path], {
      cwd: directory,
      environment,
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr:
        "error: The Drop changed since this client last observed it.\n",
      stdout: "",
    });
    expect(await readFile(bindingPath, "utf8")).toBe(originalBindingText);
    const publicResponse = await fetch(binding.url);
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(
      onePixelGif,
    );
  });

  test("prints the complete response as JSON", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "pixel.png"), onePixelPng);
    const uploadKey = await createUploadKey(workerd);

    const result = await runCli(workerd, ["pixel.png", "--json"], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: uploadKey.key },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      url: expect.stringMatching(
        new RegExp(`^${workerd.url}/files/[A-Za-z0-9_-]{32}$`),
      ),
      kind: "file",
      contentType: "image/png",
      size: onePixelPng.byteLength,
      retention: "keep",
      expiresAt: null,
      etag: expect.stringMatching(/^"[^"]+"$/),
    });
  });

  test("creates a File with the selected Retention Class", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "temporary.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);

    const result = await runCli(
      workerd,
      ["temporary.png", "--retention", "7d", "--json"],
      {
        cwd: directory,
        environment: { DROP_UPLOAD_KEY: uploadKey.key },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      retention: "7d",
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const bindingFilename = (await readdir(bindingsPath))[0];
    expect(
      JSON.parse(
        await readFile(join(bindingsPath, bindingFilename ?? ""), "utf8"),
      ),
    ).toMatchObject({ retention: "7d" });
  });

  test("changes retention by Local Path Identity and updates its binding", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "retained.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const created = await runCli(
      workerd,
      [path, "--retention", "7d", "--json"],
      { cwd: directory, environment },
    );
    expect(created.exitCode).toBe(0);
    const first = JSON.parse(created.stdout) as {
      etag: string;
      url: string;
    };

    const result = await runCli(
      workerd,
      ["retention", path, "90d", "--json"],
      { cwd: directory, environment },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      url: first.url,
      retention: "90d",
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      etag: expect.not.stringMatching(first.etag),
    });
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const bindingFilename = (await readdir(bindingsPath))[0];
    expect(
      JSON.parse(
        await readFile(join(bindingsPath, bindingFilename ?? ""), "utf8"),
      ),
    ).toMatchObject({
      url: first.url,
      retention: "90d",
      etag: expect.not.stringMatching(first.etag),
    });
    const publicResponse = await fetch(first.url);
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(
      onePixelPng,
    );
  });

  test("changes retention by exact Unlisted URL", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "by-url.png");
    await writeFile(path, onePixelPng);
    const uploadKey = await createUploadKey(workerd);
    const environment = { DROP_UPLOAD_KEY: uploadKey.key };
    const created = await runCli(workerd, [path, "--json"], {
      cwd: directory,
      environment,
    });
    expect(created.exitCode).toBe(0);
    const first = JSON.parse(created.stdout) as {
      etag: string;
      url: string;
    };

    const result = await runCli(
      workerd,
      ["retention", first.url, "30d", "--json"],
      { cwd: directory, environment },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      url: first.url,
      retention: "30d",
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const bindingsPath = join(directory, "state", "drop", "bindings");
    const bindingFilename = (await readdir(bindingsPath))[0];
    expect(
      JSON.parse(
        await readFile(join(bindingsPath, bindingFilename ?? ""), "utf8"),
      ),
    ).toMatchObject({
      url: first.url,
      retention: "30d",
      etag: expect.not.stringMatching(first.etag),
    });
  });

  test("stores a mode-0600 Upload Key and lets the environment override it", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "stored.png"), onePixelPng);
    await writeFile(join(directory, "override.png"), onePixelPng);
    const storedKey = await createUploadKey(workerd);

    const configured = await runCli(workerd, ["auth", "set"], {
      cwd: directory,
      stdin: `${storedKey.key}\n`,
    });
    expect(configured).toEqual({
      exitCode: 0,
      stderr: "Upload Key saved.\n",
      stdout: "",
    });

    const configurationPath = join(directory, "config", "drop", "config.json");
    expect(JSON.parse(await readFile(configurationPath, "utf8"))).toEqual({
      uploadKey: storedKey.key,
    });
    expect((await stat(configurationPath)).mode & 0o777).toBe(0o600);

    const fromConfiguration = await runCli(workerd, ["stored.png"], {
      cwd: directory,
    });
    expect(fromConfiguration.exitCode).toBe(0);
    expect(fromConfiguration.stdout).toContain("/files/");

    await fetch(`${workerd.url}/api/admin/keys/${storedKey.credentialId}`, {
      headers: { authorization: `Bearer ${testAdminKey}` },
      method: "DELETE",
    });
    const environmentKey = await createUploadKey(workerd);
    const fromEnvironment = await runCli(workerd, ["override.png"], {
      cwd: directory,
      environment: { DROP_UPLOAD_KEY: environmentKey.key },
    });
    expect(fromEnvironment.exitCode).toBe(0);
    expect(fromEnvironment.stdout).toContain("/files/");
  });
});
