import type { OpaqueId, Retention } from "../shared/drops.ts";
import {
  detectFileContentType as detectFileContentTypeFromBytes,
  fileContentTypeSchema,
  maxFileSize,
  type FileContentType,
  type FileUploadResponse,
} from "../shared/files.ts";
import type { CredentialId } from "../shared/upload-keys.ts";
import {
  changeDropRetention,
  createDrop,
  deleteDrop,
  listDrops,
  replaceDrop,
  serveDrop,
  type ChangeDropRetentionResult,
  type DropDescriptor,
  type DeletedDrop,
  type ListDropsInput,
  type ReplaceDropResult,
} from "./drop-content.ts";
import type { DropInventoryPage } from "../shared/drops.ts";

const fileDescriptor: DropDescriptor<"file", FileContentType> = {
  kind: "file",
  parseContentType: (value) => fileContentTypeSchema.parse(value),
};

export type UploadBodyResult =
  | { readonly status: "ok"; readonly body: Blob; readonly size: number }
  | { readonly status: "too_large" };

export async function detectFileContentType(
  body: Blob,
): Promise<FileContentType | undefined> {
  return detectFileContentTypeFromBytes(
    new Uint8Array(await body.arrayBuffer()),
  );
}

/** Reads an upload without retaining content beyond the supplied size limit. */
export async function readUploadBody(
  request: Request,
  maxSize = maxFileSize,
): Promise<UploadBodyResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maxSize
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
    if (size > maxSize) {
      await reader.cancel();
      return { status: "too_large" };
    }
    const part = new Uint8Array(next.value.byteLength);
    part.set(next.value);
    parts.push(part.buffer);
  }
}

export interface CreateFileInput {
  readonly body: Blob;
  readonly contentType: FileContentType;
  readonly credentialId: CredentialId;
  readonly originalFilename: string;
  readonly publicOrigin: string;
  readonly retention: Retention;
}

export function createFile(
  store: R2Bucket,
  input: CreateFileInput,
): Promise<FileUploadResponse> {
  return createDrop(store, fileDescriptor, input);
}

export function listFiles(
  store: R2Bucket,
  input: ListDropsInput,
): Promise<DropInventoryPage> {
  return listDrops(store, fileDescriptor, input);
}

export function deleteFile(
  store: R2Bucket,
  opaqueId: OpaqueId,
): Promise<DeletedDrop | undefined> {
  return deleteDrop(store, fileDescriptor, opaqueId);
}

export interface ReplaceFileInput extends Omit<CreateFileInput, "retention"> {
  readonly observedEtag: string;
  readonly opaqueId: OpaqueId;
  readonly retention: Retention | undefined;
}

export type ReplaceFileResult = ReplaceDropResult<"file", FileContentType>;

export function replaceFile(
  store: R2Bucket,
  input: ReplaceFileInput,
): Promise<ReplaceFileResult> {
  return replaceDrop(store, fileDescriptor, input);
}

export interface ChangeFileRetentionInput {
  readonly credentialId: CredentialId;
  readonly observedEtag: string;
  readonly opaqueId: OpaqueId;
  readonly publicOrigin: string;
  readonly retention: Retention;
}

export type ChangeFileRetentionResult = ChangeDropRetentionResult<
  "file",
  FileContentType
>;

export function changeFileRetention(
  store: R2Bucket,
  input: ChangeFileRetentionInput,
): Promise<ChangeFileRetentionResult> {
  return changeDropRetention(store, fileDescriptor, input);
}

export function serveFile(
  store: R2Bucket,
  opaqueId: OpaqueId,
  method: "GET" | "HEAD",
  requestHeaders: Headers,
): Promise<Response> {
  return serveDrop(store, fileDescriptor, opaqueId, method, requestHeaders);
}
