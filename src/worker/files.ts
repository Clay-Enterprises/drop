import type { CredentialId } from "../shared/upload-keys.ts";
import {
  opaqueIdSchema,
  type FileUploadResponse,
  type OpaqueId,
} from "../shared/files.ts";

export const maxFileSize = 95 * 1024 * 1024;

const pngSignature = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

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

export function isPng(body: Blob): Promise<boolean> {
  return body
    .slice(0, pngSignature.byteLength)
    .arrayBuffer()
    .then((prefix) => {
      const bytes = new Uint8Array(prefix);
      return (
        bytes.byteLength === pngSignature.byteLength &&
        pngSignature.every((byte, index) => bytes[index] === byte)
      );
    });
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
  credentialId: CredentialId,
  originalFilename: string,
  publicOrigin: string,
): Promise<FileUploadResponse> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const opaqueId = randomOpaqueId();
    const object = await store.put(`files/${opaqueId}`, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        cacheControl: "no-store",
        contentDisposition: "inline",
        contentType: "image/png",
      },
      customMetadata: {
        creatorCredentialId: credentialId,
        originalFilename,
        kind: "file",
        detectedType: "image/png",
        size: String(body.size),
        retention: "keep",
      },
    });
    if (object === null) {
      continue;
    }

    return {
      url: new URL(`/files/${opaqueId}`, publicOrigin).href,
      kind: "file",
      contentType: "image/png",
      size: object.size,
      retention: "keep",
      expiresAt: null,
      etag: object.httpEtag,
    };
  }

  throw new Error("Could not allocate an Opaque ID after repeated collisions");
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
