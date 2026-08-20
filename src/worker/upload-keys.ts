import type {
  CredentialId,
  CreatedUploadKey,
  UploadKeyRecord,
  UploadKeySummary,
} from "../shared/upload-keys.ts";
import {
  credentialIdSchema,
  uploadKeyRecordSchema,
  uploadKeySchema,
} from "../shared/upload-keys.ts";

const recordPrefix = "upload-keys/";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToHex(bytes);
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return bytesToHex(new Uint8Array(digest));
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function equalHash(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function createUploadKey(
  store: R2Bucket,
): Promise<CreatedUploadKey> {
  const credentialId = credentialIdSchema.parse(randomHex(16));
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = bytesToHex(secretBytes);
  const record: UploadKeyRecord = {
    createdAt: new Date().toISOString(),
    secretHash: await sha256Hex(secretBytes),
  };

  await store.put(`${recordPrefix}${credentialId}`, JSON.stringify(record));

  return {
    credentialId,
    createdAt: record.createdAt,
    key: `drop_u_${credentialId}_${secret}`,
  };
}

export async function listUploadKeys(
  store: R2Bucket,
): Promise<UploadKeySummary[]> {
  const summaries: UploadKeySummary[] = [];
  let cursor: string | undefined;

  do {
    const page = await store.list({ cursor, prefix: recordPrefix });
    const pageSummaries = await Promise.all(
      page.objects.map(async ({ key }) => {
        const object = await store.get(key);
        if (object === null) {
          return undefined;
        }

        const record = uploadKeyRecordSchema.parse(await object.json());
        return {
          credentialId: credentialIdSchema.parse(
            key.slice(recordPrefix.length),
          ),
          createdAt: record.createdAt,
        };
      }),
    );
    summaries.push(
      ...pageSummaries.filter(
        (summary): summary is UploadKeySummary => summary !== undefined,
      ),
    );
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  return summaries.sort((left, right) =>
    left.credentialId.localeCompare(right.credentialId),
  );
}

export async function revokeUploadKey(
  store: R2Bucket,
  credentialId: CredentialId,
): Promise<void> {
  await store.delete(`${recordPrefix}${credentialId}`);
}

/** Resolves the exact credential ID when an Upload Key is still active. */
export async function authenticateUploadKey(
  store: R2Bucket,
  key: string,
): Promise<CredentialId | undefined> {
  const parsed = uploadKeySchema.safeParse(key);
  if (!parsed.success) {
    return undefined;
  }

  const credentialId = credentialIdSchema.parse(parsed.data.slice(7, 39));
  const secret = parsed.data.slice(40);

  const object = await store.get(`${recordPrefix}${credentialId}`);
  if (object === null) {
    return undefined;
  }

  const record = uploadKeyRecordSchema.parse(await object.json());
  const submittedHash = await sha256Hex(hexBytes(secret));
  return equalHash(record.secretHash, submittedHash) ? credentialId : undefined;
}
