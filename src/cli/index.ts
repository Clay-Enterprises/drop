#!/usr/bin/env bun

import {
  chmod,
  mkdir,
  readFile,
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
  type FileUploadResponse,
  type LocalBinding,
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

async function pathHash(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(path),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function writeLocalBinding(
  absolutePath: string,
  response: FileUploadResponse,
): Promise<void> {
  const binding: LocalBinding = {
    path: absolutePath,
    url: response.url,
    kind: response.kind,
    etag: response.etag,
    retention: response.retention,
  };
  const filename = `${await pathHash(absolutePath)}.json`;
  await atomicWriteJson(
    join(stateRoot(), "drop", "bindings", filename),
    binding,
  );
}

async function uploadFile(pathInput: string): Promise<FileUploadResponse> {
  const absolutePath = resolve(pathInput);
  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
    throw new CliError(`The File does not exist: ${absolutePath}`, 1);
  }

  const uploadKey = await resolveUploadKey();
  const environment = readApiEnvironment();
  const response = await fetch(new URL("/api/files", environment.DROP_API_URL), {
    body: file,
    headers: {
      authorization: `Bearer ${uploadKey}`,
      "content-disposition": encodedFilename(basename(absolutePath)),
      "content-type": "application/octet-stream",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw await responseError(response);
  }

  const created = fileUploadResponseSchema.parse(await response.json());
  await writeLocalBinding(absolutePath, created);
  return created;
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
    arguments_.length >= 1 &&
    arguments_.length <= 2 &&
    arguments_[0] !== undefined &&
    !arguments_[0].startsWith("-") &&
    (arguments_.length === 1 || arguments_[1] === "--json")
  ) {
    const created = await uploadFile(arguments_[0]);
    console.log(
      arguments_[1] === "--json"
        ? JSON.stringify(created)
        : created.url,
    );
    return 0;
  }

  throw new CliError("Usage: drop <path> [--json] | drop auth set", 2);
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
