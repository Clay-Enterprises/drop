import type { CredentialId } from "../shared/upload-keys.ts";
import {
  type FileContentType,
  opaqueIdSchema,
  retentionSchema,
  type FileUploadResponse,
  type OpaqueId,
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

export async function createFile(
  store: R2Bucket,
  body: Blob,
  contentType: FileContentType,
  credentialId: CredentialId,
  originalFilename: string,
  publicOrigin: string,
): Promise<FileUploadResponse> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const opaqueId = randomOpaqueId();
    const writeEtag = randomWriteEtag();
    const object = await store.put(`files/${opaqueId}`, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        cacheControl: "no-store",
        contentDisposition: "inline",
        contentType,
      },
      customMetadata: {
        creatorCredentialId: credentialId,
        originalFilename,
        kind: "file",
        detectedType: contentType,
        size: String(body.size),
        retention: "keep",
        writeEtag,
      },
    });
    if (object === null) {
      continue;
    }

    return {
      url: new URL(`/files/${opaqueId}`, publicOrigin).href,
      kind: "file",
      contentType,
      size: object.size,
      retention: "keep",
      expiresAt: null,
      etag: writeEtag,
    };
  }

  throw new Error("Could not allocate an Opaque ID after repeated collisions");
}

export type ReplaceFileResult =
  | { readonly status: "forbidden" }
  | { readonly status: "missing" }
  | { readonly status: "replaced"; readonly response: FileUploadResponse }
  | { readonly status: "stale" };

function nextExpiresAt(retention: FileUploadResponse["retention"]): string | null {
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

async function waitForNextUploadTime(uploaded: Date): Promise<number> {
  const nextUploadTime = uploaded.getTime() + 1;
  const delay = nextUploadTime - Date.now();
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return nextUploadTime;
}

export async function replaceFile(
  store: R2Bucket,
  opaqueId: OpaqueId,
  body: Blob,
  contentType: FileContentType,
  credentialId: CredentialId,
  originalFilename: string,
  observedEtag: string,
  publicOrigin: string,
): Promise<ReplaceFileResult> {
  const key = `files/${opaqueId}`;
  const current = await store.head(key);
  if (current === null) {
    return { status: "missing" };
  }
  if (current.customMetadata?.creatorCredentialId !== credentialId) {
    return { status: "forbidden" };
  }
  const currentWriteEtag =
    current.customMetadata?.writeEtag ?? current.httpEtag;
  if (currentWriteEtag !== observedEtag) {
    return { status: "stale" };
  }

  const retention = retentionSchema.parse(current.customMetadata.retention);
  const expiresAt = nextExpiresAt(retention);
  const writeEtag = randomWriteEtag();
  const nextUploadTime = await waitForNextUploadTime(current.uploaded);
  const object = await store.put(key, body, {
    // R2 content ETags can recur for identical bytes. Upload time identifies
    // the exact object version while the API ETag guards the client's view.
    onlyIf: {
      uploadedAfter: new Date(nextUploadTime - 2),
      uploadedBefore: new Date(nextUploadTime),
      secondsGranularity: false,
    },
    httpMetadata: {
      cacheControl: "no-store",
      contentDisposition: "inline",
      contentType,
    },
    customMetadata: {
      creatorCredentialId: credentialId,
      originalFilename,
      kind: "file",
      detectedType: contentType,
      size: String(body.size),
      retention,
      ...(expiresAt === null ? {} : { expiresAt }),
      writeEtag,
    },
  });
  if (object === null) {
    return { status: "stale" };
  }

  return {
    status: "replaced",
    response: {
      url: new URL(`/files/${opaqueId}`, publicOrigin).href,
      kind: "file",
      contentType,
      size: object.size,
      retention,
      expiresAt,
      etag: writeEtag,
    },
  };
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
