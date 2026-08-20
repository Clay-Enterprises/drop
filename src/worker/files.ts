import {
  credentialIdSchema,
  type CredentialId,
} from "../shared/upload-keys.ts";
import {
  type FileContentType,
  fileContentTypeSchema,
  opaqueIdSchema,
  retentionSchema,
  type FileUploadResponse,
  type OpaqueId,
  type Retention,
} from "../shared/files.ts";

export const maxFileSize = 95 * 1024 * 1024;

const signatures = {
  gif87a: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
  gif89a: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
} as const;

export type UploadBodyResult =
  | { readonly status: "ok"; readonly body: Blob; readonly size: number }
  | { readonly status: "too_large" };

export type ByteRange = {
  readonly offset: number;
  readonly length: number;
};

function randomOpaqueId(): OpaqueId {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const base64 = btoa(String.fromCharCode(...bytes));
  return opaqueIdSchema.parse(
    base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
  );
}

/** Creates the version ETag for the authenticated `/api/files` resource. */
function randomWriteEtag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const value = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `"${value}"`;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return (
    bytes.byteLength >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte)
  );
}

export async function detectFileContentType(
  body: Blob,
): Promise<FileContentType | undefined> {
  const bytes = new Uint8Array(await body.slice(0, 8).arrayBuffer());
  if (startsWith(bytes, signatures.png)) return "image/png";
  if (
    startsWith(bytes, signatures.gif87a) ||
    startsWith(bytes, signatures.gif89a)
  ) {
    return "image/gif";
  }
  return undefined;
}

/** Reads an upload without retaining content beyond the hard size limit. */
export async function readUploadBody(
  request: Request,
): Promise<UploadBodyResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maxFileSize
    ) {
      await request.body?.cancel();
      return { status: "too_large" };
    }
  }

  if (request.body === null) {
    return { status: "ok", body: new Blob(), size: 0 };
  }

  const reader = request.body.getReader();
  const parts: ArrayBuffer[] = [];
  let size = 0;

  while (true) {
    const next = await reader.read();
    if (next.done) {
      return { status: "ok", body: new Blob(parts), size };
    }

    size += next.value.byteLength;
    if (size > maxFileSize) {
      await reader.cancel();
      return { status: "too_large" };
    }

    const part = new Uint8Array(next.value.byteLength);
    part.set(next.value);
    parts.push(part.buffer);
  }
}

type FileWriteState = {
  readonly contentType: FileContentType;
  readonly expiresAt: string | null;
  readonly retention: Retention;
  readonly size: number;
  readonly writeEtag: string;
};

type StoredFileMetadata = {
  readonly contentType: FileContentType;
  readonly credentialId: CredentialId;
  readonly originalFilename: string;
  readonly retention: Retention;
  readonly writeEtag: string;
};

type FileWriteAuthorization<T extends R2Object> =
  | {
      readonly status: "authorized";
      readonly current: T;
      readonly metadata: StoredFileMetadata;
    }
  | { readonly status: "forbidden" }
  | { readonly status: "missing" }
  | { readonly status: "stale" };

function authorizeFileWrite<T extends R2Object>(
  current: T | null,
  credentialId: CredentialId,
  observedEtag: string,
): FileWriteAuthorization<T> {
  if (current === null || current.customMetadata?.kind !== "file") {
    return { status: "missing" };
  }

  const metadata: StoredFileMetadata = {
    contentType: fileContentTypeSchema.parse(
      current.customMetadata.detectedType,
    ),
    credentialId: credentialIdSchema.parse(
      current.customMetadata.creatorCredentialId,
    ),
    originalFilename: current.customMetadata.originalFilename ?? "",
    retention: retentionSchema.parse(current.customMetadata.retention),
    writeEtag: current.customMetadata.writeEtag ?? current.httpEtag,
  };
  if (metadata.credentialId !== credentialId) {
    return { status: "forbidden" };
  }
  if (metadata.writeEtag !== observedEtag) {
    return { status: "stale" };
  }
  return { status: "authorized", current, metadata };
}

function fileCustomMetadata(
  credentialId: CredentialId,
  originalFilename: string,
  state: FileWriteState,
): Record<string, string> {
  return {
    creatorCredentialId: credentialId,
    originalFilename,
    kind: "file",
    detectedType: state.contentType,
    size: String(state.size),
    retention: state.retention,
    ...(state.expiresAt === null ? {} : { expiresAt: state.expiresAt }),
    writeEtag: state.writeEtag,
  };
}

function fileUploadResponse(
  opaqueId: OpaqueId,
  publicOrigin: string,
  state: FileWriteState,
): FileUploadResponse {
  return {
    url: new URL(`/files/${opaqueId}`, publicOrigin).href,
    kind: "file",
    contentType: state.contentType,
    size: state.size,
    retention: state.retention,
    expiresAt: state.expiresAt,
    etag: state.writeEtag,
  };
}

export interface CreateFileInput {
  readonly body: Blob;
  readonly contentType: FileContentType;
  readonly credentialId: CredentialId;
  readonly originalFilename: string;
  readonly publicOrigin: string;
  readonly retention: Retention;
}

export async function createFile(
  store: R2Bucket,
  input: CreateFileInput,
): Promise<FileUploadResponse> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const opaqueId = randomOpaqueId();
    const writeEtag = randomWriteEtag();
    const state: FileWriteState = {
      contentType: input.contentType,
      expiresAt: nextExpiresAt(input.retention),
      retention: input.retention,
      size: input.body.size,
      writeEtag,
    };
    const object = await store.put(`files/${opaqueId}`, input.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        cacheControl: "no-store",
        contentDisposition: "inline",
        contentType: input.contentType,
      },
      customMetadata: fileCustomMetadata(
        input.credentialId,
        input.originalFilename,
        state,
      ),
    });
    if (object === null) {
      continue;
    }

    return fileUploadResponse(opaqueId, input.publicOrigin, {
      ...state,
      size: object.size,
    });
  }

  throw new Error("Could not allocate an Opaque ID after repeated collisions");
}

export type ReplaceFileResult =
  | { readonly status: "forbidden" }
  | { readonly status: "missing" }
  | { readonly status: "replaced"; readonly response: FileUploadResponse }
  | { readonly status: "stale" };

export type ChangeFileRetentionResult =
  | { readonly status: "forbidden" }
  | { readonly status: "missing" }
  | { readonly status: "stale" }
  | { readonly status: "updated"; readonly response: FileUploadResponse };

function nextExpiresAt(retention: Retention): string | null {
  const duration = {
    "7d": 7 * 24 * 60 * 60 * 1_000,
    "30d": 30 * 24 * 60 * 60 * 1_000,
    "90d": 90 * 24 * 60 * 60 * 1_000,
    keep: undefined,
  }[retention];
  return duration === undefined
    ? null
    : new Date(Date.now() + duration).toISOString();
}

async function waitForNextUploadTime(uploaded: Date): Promise<void> {
  const nextUploadTime = uploaded.getTime() + 1;
  const delay = nextUploadTime - Date.now();
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function exactUploadTime(uploaded: Date): R2Conditional {
  const time = uploaded.getTime();
  return {
    uploadedAfter: new Date(time - 1),
    uploadedBefore: new Date(time + 1),
    secondsGranularity: false,
  };
}

export interface ReplaceFileInput {
  readonly body: Blob;
  readonly contentType: FileContentType;
  readonly credentialId: CredentialId;
  readonly observedEtag: string;
  readonly originalFilename: string;
  readonly opaqueId: OpaqueId;
  readonly publicOrigin: string;
  readonly retention: Retention | undefined;
}

export async function replaceFile(
  store: R2Bucket,
  input: ReplaceFileInput,
): Promise<ReplaceFileResult> {
  const key = `files/${input.opaqueId}`;
  const current = await store.head(key);
  const authorization = authorizeFileWrite(
    current,
    input.credentialId,
    input.observedEtag,
  );
  if (authorization.status !== "authorized") {
    return authorization;
  }

  const retention =
    input.retention ?? authorization.metadata.retention;
  const state: FileWriteState = {
    contentType: input.contentType,
    expiresAt: nextExpiresAt(retention),
    retention,
    size: input.body.size,
    writeEtag: randomWriteEtag(),
  };
  await waitForNextUploadTime(authorization.current.uploaded);
  const object = await store.put(key, input.body, {
    // R2 content ETags can recur for identical bytes. Upload time identifies
    // the exact object version while the API ETag guards the client's view.
    onlyIf: exactUploadTime(authorization.current.uploaded),
    httpMetadata: {
      cacheControl: "no-store",
      contentDisposition: "inline",
      contentType: input.contentType,
    },
    customMetadata: fileCustomMetadata(
      input.credentialId,
      input.originalFilename,
      state,
    ),
  });
  if (object === null) {
    return { status: "stale" };
  }

  return {
    status: "replaced",
    response: fileUploadResponse(input.opaqueId, input.publicOrigin, {
      ...state,
      size: object.size,
    }),
  };
}

export interface ChangeFileRetentionInput {
  readonly credentialId: CredentialId;
  readonly observedEtag: string;
  readonly opaqueId: OpaqueId;
  readonly publicOrigin: string;
  readonly retention: Retention;
}

export async function changeFileRetention(
  store: R2Bucket,
  input: ChangeFileRetentionInput,
): Promise<ChangeFileRetentionResult> {
  const key = `files/${input.opaqueId}`;
  const current = await store.get(key);
  const authorization = authorizeFileWrite(
    current,
    input.credentialId,
    input.observedEtag,
  );
  if (authorization.status !== "authorized") {
    return authorization;
  }

  const state: FileWriteState = {
    contentType: authorization.metadata.contentType,
    expiresAt: nextExpiresAt(input.retention),
    retention: input.retention,
    size: authorization.current.size,
    writeEtag: randomWriteEtag(),
  };
  await waitForNextUploadTime(authorization.current.uploaded);
  const object = await store.put(key, authorization.current.body, {
    onlyIf: exactUploadTime(authorization.current.uploaded),
    httpMetadata: authorization.current.httpMetadata,
    customMetadata: fileCustomMetadata(
      authorization.metadata.credentialId,
      authorization.metadata.originalFilename,
      state,
    ),
  });
  if (object === null) {
    return { status: "stale" };
  }

  return {
    status: "updated",
    response: fileUploadResponse(input.opaqueId, input.publicOrigin, {
      ...state,
      size: object.size,
    }),
  };
}

export interface ExpirySweepOptions {
  readonly afterTombstone?: (
    candidate: R2Object,
  ) => Promise<boolean | undefined>;
  readonly beforeTombstone?: (
    candidate: R2Object,
  ) => Promise<boolean | undefined>;
  readonly pageSize?: number;
}

export async function writeExpiryTombstone(
  store: R2Bucket,
  candidate: R2Object,
): Promise<boolean> {
  const current = await store.head(candidate.key);
  if (
    current === null ||
    current.etag !== candidate.etag ||
    current.uploaded.getTime() !== candidate.uploaded.getTime()
  ) {
    return false;
  }

  const tombstone = await store.put(candidate.key, new Uint8Array(), {
    // R2 content ETags can recur for identical bytes. The listed ETag is
    // checked above; upload time makes the conditional write version-exact.
    onlyIf: exactUploadTime(candidate.uploaded),
  });
  return tombstone !== null;
}

export async function sweepExpiredFiles(
  store: R2Bucket,
  now: number,
  options: ExpirySweepOptions = {},
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await store.list({
      cursor,
      limit: options.pageSize ?? 1_000,
      include: ["customMetadata"],
    });

    for (const candidate of page.objects) {
      const retention = retentionSchema.safeParse(
        candidate.customMetadata?.retention,
      );
      if (
        !retention.success ||
        retention.data === "keep" ||
        candidate.customMetadata?.expiresAt === undefined ||
        new Date(candidate.customMetadata.expiresAt).getTime() > now
      ) {
        continue;
      }

      if ((await options.beforeTombstone?.(candidate)) === false) {
        return;
      }
      if (await writeExpiryTombstone(store, candidate)) {
        if ((await options.afterTombstone?.(candidate)) === false) {
          return;
        }
        await store.delete(candidate.key);
      }
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }

  return header.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, "");
    return normalized === "*" || normalized === etag;
  });
}

export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | undefined | null {
  if (header === undefined) {
    return undefined;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return null;
  }

  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") {
    return null;
  }

  if (startText === "") {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || size === 0) {
      return null;
    }
    const length = Math.min(suffixLength, size);
    return { offset: size - length, length };
  }

  const offset = Number(startText);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) {
    return null;
  }

  if (endText === "") {
    return { offset, length: size - offset };
  }

  const submittedEnd = Number(endText);
  if (!Number.isSafeInteger(submittedEnd) || submittedEnd < offset) {
    return null;
  }
  const end = Math.min(submittedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

function publicFileHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "no-store");
  headers.set("etag", object.httpEtag);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return headers;
}

export async function serveFile(
  store: R2Bucket,
  opaqueId: OpaqueId,
  method: "GET" | "HEAD",
  requestHeaders: Headers,
): Promise<Response> {
  const key = `files/${opaqueId}`;
  const head = await store.head(key);
  if (head === null) {
    return new Response(null, { status: 404 });
  }

  const headers = publicFileHeaders(head);
  if (matchesEtag(requestHeaders.get("if-none-match") ?? undefined, head.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }

  const range = parseByteRange(
    requestHeaders.get("range") ?? undefined,
    head.size,
  );
  if (range === null) {
    headers.set("content-range", `bytes */${head.size}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }

  const status = range === undefined ? 200 : 206;
  const responseSize = range?.length ?? head.size;
  headers.set("content-length", String(responseSize));
  if (range !== undefined) {
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
    );
  }

  if (method === "HEAD") {
    return new Response(null, { status, headers });
  }

  const object = await store.get(
    key,
    range === undefined ? undefined : { range },
  );
  if (object === null) {
    return new Response(null, { status: 404 });
  }
  return new Response(object.body, { status, headers });
}
