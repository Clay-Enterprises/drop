#!/usr/bin/env bun

import { z } from "zod";

import { errorResponseSchema } from "../shared/errors.ts";
import type {
  CreatedUploadKey,
  UploadKeySummary,
} from "../shared/upload-keys.ts";
import {
  credentialIdSchema,
  createdUploadKeySchema,
  uploadKeyListSchema,
} from "../shared/upload-keys.ts";

const environmentSchema = z.object({
  DROP_ADMIN_KEY: z.string().startsWith("drop_a_"),
  DROP_API_URL: z.url().default("https://drop.clay.sh"),
});

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

function readEnvironment(): z.infer<typeof environmentSchema> {
  const environment = environmentSchema.safeParse(Bun.env);
  if (!environment.success) {
    throw new CliError(
      "DROP_ADMIN_KEY must contain a valid Admin Key.",
      1,
    );
  }
  return environment.data;
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
  const environment = readEnvironment();
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

async function main(arguments_: string[]): Promise<number> {
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
