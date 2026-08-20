#!/usr/bin/env bun

import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import { errorResponseSchema } from "../shared/errors.ts";
import {
  fileUploadResponseSchema,
  localBindingSchema,
  opaqueIdSchema,
  retentionSchema,
  type FileUploadResponse,
  type LocalBinding,
  type LocalBindingContent,
  type Retention,
} from "../shared/files.ts";
import type {
  CreatedUploadKey,
  UploadKeySummary,
} from "../shared/upload-keys.ts";
import {
  credentialIdSchema,
  createdUploadKeySchema,
  uploadKeyListSchema,
  uploadKeySchema,
} from "../shared/upload-keys.ts";

const apiEnvironmentSchema = z.object({
  DROP_API_URL: z.url().default("https://drop.clay.sh"),
});

const adminEnvironmentSchema = apiEnvironmentSchema.extend({
  DROP_ADMIN_KEY: z.string().startsWith("drop_a_"),
});

const uploadKeyConfigurationSchema = z
  .object({ uploadKey: uploadKeySchema })
  .strict();

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

function readApiEnvironment(): z.infer<typeof apiEnvironmentSchema> {
  const environment = apiEnvironmentSchema.safeParse(Bun.env);
  if (!environment.success) {
    throw new CliError("DROP_API_URL must contain a valid URL.", 1);
  }
  return environment.data;
}

function readAdminEnvironment(): z.infer<typeof adminEnvironmentSchema> {
  const environment = adminEnvironmentSchema.safeParse(Bun.env);
  if (!environment.success) {
    throw new CliError(
      "DROP_ADMIN_KEY must contain a valid Admin Key.",
      1,
    );
  }
  return environment.data;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function configurationRoot(): string {
  const configured = Bun.env.XDG_CONFIG_HOME;
  return configured === undefined || configured === ""
    ? join(homedir(), ".config")
    : resolve(configured);
}

function stateRoot(): string {
  const configured = Bun.env.XDG_STATE_HOME;
  return configured === undefined || configured === ""
    ? join(homedir(), ".local", "state")
    : resolve(configured);
}

function uploadKeyConfigurationPath(): string {
  return join(configurationRoot(), "drop", "config.json");
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
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

async function saveUploadKey(keyInput: string): Promise<void> {
  const key = uploadKeySchema.safeParse(keyInput.trim());
  if (!key.success) {
    throw new CliError("The Upload Key is invalid.", 2);
  }

  await atomicWriteJson(uploadKeyConfigurationPath(), {
    uploadKey: key.data,
  });
}

async function readStoredUploadKey(): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(uploadKeyConfigurationPath(), "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new CliError(
        "No Upload Key is configured. Run `drop auth set` or set DROP_UPLOAD_KEY.",
        1,
      );
    }
    throw error;
  }

  try {
    return uploadKeyConfigurationSchema.parse(JSON.parse(contents)).uploadKey;
  } catch {
    throw new CliError(
      "The stored Upload Key configuration is invalid. Run `drop auth set` to replace it.",
      1,
    );
  }
}

async function resolveUploadKey(): Promise<string> {
  if (Bun.env.DROP_UPLOAD_KEY !== undefined) {
    const key = uploadKeySchema.safeParse(Bun.env.DROP_UPLOAD_KEY);
    if (!key.success) {
      throw new CliError("DROP_UPLOAD_KEY must contain a valid Upload Key.", 1);
    }
    return key.data;
  }

  return readStoredUploadKey();
}

async function responseError(response: Response): Promise<CliError> {
  const body = errorResponseSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  return new CliError(
    body.success
      ? body.data.error.message
      : `The Drop server returned HTTP ${response.status}.`,
    1,
  );
}

async function adminRequest(
  path: string,
  method: "DELETE" | "GET" | "POST" = "GET",
): Promise<Response> {
  const environment = readAdminEnvironment();
  const response = await fetch(new URL(path, environment.DROP_API_URL), {
    headers: {
      authorization: `Bearer ${environment.DROP_ADMIN_KEY}`,
    },
    method,
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return response;
}

async function createUploadKey(): Promise<CreatedUploadKey> {
  const response = await adminRequest("/api/admin/keys", "POST");
  return createdUploadKeySchema.parse(await response.json());
}

async function listUploadKeys(): Promise<UploadKeySummary[]> {
  const response = await adminRequest("/api/admin/keys");
  return uploadKeyListSchema.parse(await response.json()).keys;
}

async function revokeUploadKey(credentialIdInput: string): Promise<void> {
  const credentialId = credentialIdSchema.safeParse(credentialIdInput);
  if (!credentialId.success) {
    throw new CliError("The credential ID is invalid.", 2);
  }

  await adminRequest(
    `/api/admin/keys/${credentialId.data}`,
    "DELETE",
  );
}

function encodedFilename(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (value) =>
    `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename*=UTF-8''${encoded}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function writeLocalBinding(
  absolutePath: string,
  response: FileUploadResponse,
): Promise<void> {
  const content: LocalBindingContent = {
    path: absolutePath,
    url: response.url,
    kind: response.kind,
    etag: response.etag,
    retention: response.retention,
  };
  const binding: LocalBinding = {
    ...content,
    checksum: await bindingChecksum(content),
    formatVersion: 1,
  };
  await atomicWriteJson(await localBindingPath(absolutePath), binding);
}

function canonicalBindingContent(binding: LocalBindingContent): string {
  return JSON.stringify({
    path: binding.path,
    url: binding.url,
    kind: binding.kind,
    etag: binding.etag,
    retention: binding.retention,
  });
}

function bindingChecksum(binding: LocalBindingContent): Promise<string> {
  return sha256Hex(canonicalBindingContent(binding));
}

async function localBindingPath(absolutePath: string): Promise<string> {
  return join(
    localBindingsDirectory(),
    `${await sha256Hex(absolutePath)}.json`,
  );
}

function localBindingsDirectory(): string {
  return join(stateRoot(), "drop", "bindings");
}

async function readLocalBinding(
  absolutePath: string,
): Promise<LocalBinding | undefined> {
  let contents: string;
  try {
    contents = await readFile(await localBindingPath(absolutePath), "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }

  try {
    const binding = localBindingSchema.parse(JSON.parse(contents));
    const url = new URL(binding.url);
    const opaqueId = opaqueIdSchema.safeParse(
      /^\/files\/([^/]+)$/.exec(url.pathname)?.[1],
    );
    const checksum = await bindingChecksum(binding);
    if (
      binding.path !== absolutePath ||
      !opaqueId.success ||
      ("checksum" in binding && binding.checksum !== checksum)
    ) {
      throw new Error("invalid binding identity");
    }
    return binding;
  } catch {
    throw new CliError(
      `The local binding for this path is corrupt: ${absolutePath}`,
      1,
    );
  }
}

async function readLocalBindingByUrl(
  url: string,
): Promise<LocalBinding | undefined> {
  let entries: string[];
  try {
    entries = await readdir(localBindingsDirectory());
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }

  for (const entry of entries) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(
        await readFile(join(localBindingsDirectory(), entry), "utf8"),
      );
    } catch {
      continue;
    }
    const parsed = localBindingSchema.safeParse(candidate);
    if (parsed.success && parsed.data.url === url) {
      return readLocalBinding(parsed.data.path);
    }
  }
  return undefined;
}

function replacementApiPath(binding: LocalBinding): string {
  const opaqueId = opaqueIdSchema.parse(
    /^\/files\/([^/]+)$/.exec(new URL(binding.url).pathname)?.[1],
  );
  return `/api/files/${opaqueId}`;
}

async function sendFile(
  absolutePath: string,
  file: Blob,
  uploadKey: string,
  environment: z.infer<typeof apiEnvironmentSchema>,
  binding: LocalBinding | undefined,
  retention: Retention | undefined,
): Promise<Response> {
  const apiOrigin = new URL(environment.DROP_API_URL).origin;
  if (binding !== undefined) {
    const bindingOrigin = new URL(binding.url).origin;
    if (bindingOrigin !== apiOrigin) {
      throw new CliError(
        `The local binding belongs to ${bindingOrigin}, not ${apiOrigin}.`,
        1,
      );
    }
  }

  const response = await fetch(
    new URL(
      binding === undefined ? "/api/files" : replacementApiPath(binding),
      environment.DROP_API_URL,
    ),
    {
      body: file,
      headers: {
        authorization: `Bearer ${uploadKey}`,
        "content-disposition": encodedFilename(basename(absolutePath)),
        "content-type": "application/octet-stream",
        ...(binding === undefined ? {} : { "if-match": binding.etag }),
        ...(retention === undefined ? {} : { "drop-retention": retention }),
      },
      method: binding === undefined ? "POST" : "PUT",
    },
  );

  if (response.status === 404 && binding !== undefined) {
    if (!("formatVersion" in binding)) {
      throw new CliError(
        `The legacy local binding could not be verified: ${absolutePath}`,
        1,
      );
    }
    return sendFile(
      absolutePath,
      file,
      uploadKey,
      environment,
      undefined,
      retention,
    );
  }
  return response;
}

async function uploadFile(
  pathInput: string,
  retention: Retention | undefined,
): Promise<FileUploadResponse> {
  const resolvedPath = resolve(pathInput);
  const file = Bun.file(resolvedPath);
  if (!(await file.exists())) {
    throw new CliError(`The File does not exist: ${resolvedPath}`, 1);
  }

  const absolutePath = await realpath(resolvedPath);
  const binding = await readLocalBinding(absolutePath);
  const uploadKey = await resolveUploadKey();
  const environment = readApiEnvironment();
  const response = await sendFile(
    absolutePath,
    file,
    uploadKey,
    environment,
    binding,
    retention,
  );
  if (!response.ok) {
    throw await responseError(response);
  }

  const created = fileUploadResponseSchema.parse(await response.json());
  await writeLocalBinding(absolutePath, created);
  return created;
}

async function changeFileRetention(
  pathOrUrl: string,
  retention: Retention,
): Promise<FileUploadResponse> {
  const environment = readApiEnvironment();
  const apiOrigin = new URL(environment.DROP_API_URL).origin;
  const submittedUrl = z.url().safeParse(pathOrUrl);
  let absolutePath: string;
  let binding: LocalBinding | undefined;
  if (submittedUrl.success) {
    const url = new URL(submittedUrl.data);
    const opaqueId = opaqueIdSchema.safeParse(
      /^\/files\/([^/]+)$/.exec(url.pathname)?.[1],
    );
    if (
      url.origin !== apiOrigin ||
      url.search !== "" ||
      url.hash !== "" ||
      !opaqueId.success
    ) {
      throw new CliError(
        `The value is not an exact File Unlisted URL: ${pathOrUrl}`,
        2,
      );
    }
    binding = await readLocalBindingByUrl(url.href);
    if (binding === undefined) {
      throw new CliError(
        `No local binding exists for this Unlisted URL: ${url.href}`,
        1,
      );
    }
    absolutePath = binding.path;
  } else {
    const resolvedPath = resolve(pathOrUrl);
    const file = Bun.file(resolvedPath);
    if (!(await file.exists())) {
      throw new CliError(`The File does not exist: ${resolvedPath}`, 1);
    }
    absolutePath = await realpath(resolvedPath);
    binding = await readLocalBinding(absolutePath);
  }

  if (binding === undefined) {
    throw new CliError(
      `No local binding exists for this path: ${absolutePath}`,
      1,
    );
  }

  const bindingOrigin = new URL(binding.url).origin;
  if (bindingOrigin !== apiOrigin) {
    throw new CliError(
      `The local binding belongs to ${bindingOrigin}, not ${apiOrigin}.`,
      1,
    );
  }

  const response = await fetch(
    new URL(replacementApiPath(binding), environment.DROP_API_URL),
    {
      body: JSON.stringify({ retention }),
      headers: {
        authorization: `Bearer ${await resolveUploadKey()}`,
        "content-type": "application/json",
        "if-match": binding.etag,
      },
      method: "PATCH",
    },
  );
  if (!response.ok) {
    throw await responseError(response);
  }

  const changed = fileUploadResponseSchema.parse(await response.json());
  await writeLocalBinding(absolutePath, changed);
  return changed;
}

type UploadCommand = {
  readonly json: boolean;
  readonly path: string;
  readonly retention: Retention | undefined;
};

function parseUploadCommand(arguments_: string[]): UploadCommand | undefined {
  const path = arguments_[0];
  if (path === undefined || path.startsWith("-")) {
    return undefined;
  }

  let json = false;
  let retention: Retention | undefined;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json" && !json) {
      json = true;
      continue;
    }
    if (argument === "--retention" && retention === undefined) {
      const parsed = retentionSchema.safeParse(arguments_[index + 1]);
      if (!parsed.success) {
        throw new CliError(
          "--retention must be 7d, 30d, 90d, or keep.",
          2,
        );
      }
      retention = parsed.data;
      index += 1;
      continue;
    }
    return undefined;
  }

  return { json, path, retention };
}

async function runAdminCommand(arguments_: string[]): Promise<number> {
  if (
    (arguments_.length === 4 ||
      (arguments_.length === 5 && arguments_[4] === "--json")) &&
    arguments_[0] === "admin" &&
    arguments_[1] === "keys" &&
    arguments_[2] === "revoke"
  ) {
    const credentialId = arguments_[3] ?? "";
    await revokeUploadKey(credentialId);
    if (arguments_[4] === "--json") {
      console.log(JSON.stringify({ credentialId, revoked: true }));
    }
    return 0;
  }

  switch (arguments_.join(" ")) {
    case "admin keys create":
      console.log((await createUploadKey()).key);
      return 0;
    case "admin keys create --json":
      console.log(JSON.stringify(await createUploadKey()));
      return 0;
    case "admin keys list": {
      const output = (await listUploadKeys())
        .map(({ credentialId, createdAt }) => `${credentialId}\t${createdAt}`)
        .join("\n");
      if (output !== "") {
        console.log(output);
      }
      return 0;
    }
    case "admin keys list --json":
      console.log(JSON.stringify({ keys: await listUploadKeys() }));
      return 0;
    default:
      throw new CliError(
        "Usage: drop admin keys create|list|revoke <credential-id>",
        2,
      );
  }
}

async function main(arguments_: string[]): Promise<number> {
  if (arguments_[0] === "admin") {
    return runAdminCommand(arguments_);
  }

  if (arguments_.join(" ") === "auth set") {
    const input = await Bun.stdin.text();
    await saveUploadKey(input);
    console.error("Upload Key saved.");
    return 0;
  }

  if (
    (arguments_.length === 3 ||
      (arguments_.length === 4 && arguments_[3] === "--json")) &&
    arguments_[0] === "retention" &&
    arguments_[1] !== undefined
  ) {
    const retention = retentionSchema.safeParse(arguments_[2]);
    if (!retention.success) {
      throw new CliError(
        "Retention Class must be 7d, 30d, 90d, or keep.",
        2,
      );
    }
    const changed = await changeFileRetention(
      arguments_[1],
      retention.data,
    );
    console.log(
      arguments_[3] === "--json"
        ? JSON.stringify(changed)
        : changed.url,
    );
    return 0;
  }

  const uploadCommand = parseUploadCommand(arguments_);
  if (uploadCommand !== undefined) {
    const created = await uploadFile(
      uploadCommand.path,
      uploadCommand.retention,
    );
    console.log(
      uploadCommand.json
        ? JSON.stringify(created)
        : created.url,
    );
    return 0;
  }

  throw new CliError(
    "Usage: drop <path> [--retention 7d|30d|90d|keep] [--json] | drop retention <path-or-url> <retention> [--json] | drop auth set",
    2,
  );
}

try {
  process.exitCode = await main(Bun.argv.slice(2));
} catch (error) {
  const cliError =
    error instanceof CliError
      ? error
      : new CliError("The command failed unexpectedly.", 1);
  console.error(`error: ${cliError.message}`);
  process.exitCode = cliError.exitCode;
}
