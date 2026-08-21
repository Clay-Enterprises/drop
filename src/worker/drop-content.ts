import {
  opaqueIdSchema,
  retentionSchema,
  type DropInventoryEntry,
  type DropInventoryPage,
  type DropKind,
  type OpaqueId,
  type Retention,
} from "../shared/drops.ts";
import {
  credentialIdSchema,
  type CredentialId,
} from "../shared/upload-keys.ts";

export interface DropDescriptor<
  Kind extends DropKind,
  ContentType extends string,
> {
  readonly kind: Kind;
  readonly parseContentType: (value: unknown) => ContentType;
  readonly publicHeaders?: Readonly<Record<string, string>>;
}

export interface ListDropsInput {
  readonly cursor: string | undefined;
  readonly limit: number;
  readonly publicOrigin: string;
}

export async function listDrops<
  Kind extends DropKind,
  ContentType extends string,
>(
  store: R2Bucket,
  descriptor: DropDescriptor<Kind, ContentType>,
  input: ListDropsInput,
): Promise<DropInventoryPage> {
  const prefix = `${descriptor.kind}s/`;
  const page = await store.list({
    prefix,
    cursor: input.cursor,
    limit: input.limit,
    include: ["customMetadata"],
  });
  const drops: DropInventoryEntry[] = [];
  for (const object of page.objects) {
    const opaqueId = opaqueIdSchema.safeParse(object.key.slice(prefix.length));
    const retention = retentionSchema.safeParse(
      object.customMetadata?.retention,
    );
    const owner = credentialIdSchema.safeParse(
      object.customMetadata?.creatorCredentialId,
    );
    if (
      !opaqueId.success ||
      !retention.success ||
      !owner.success ||
      object.customMetadata?.kind !== descriptor.kind ||
      object.customMetadata.originalFilename === undefined
    ) {
      continue;
    }
    let contentType: ContentType;
    try {
      contentType = descriptor.parseContentType(
        object.customMetadata.detectedType,
      );
    } catch {
      continue;
    }
    const expiresAt = object.customMetadata.expiresAt ?? null;
    if (
      expiresAt !== null &&
      !Number.isFinite(new Date(expiresAt).getTime())
    ) {
      continue;
    }
    drops.push({
      url: new URL(`/${object.key}`, input.publicOrigin).href,
      kind: descriptor.kind,
      retention: retention.data,
      owner: owner.data,
      uploadedAt: object.uploaded.toISOString(),
      expiresAt,
      size: object.size,
      contentType,
      originalFilename: object.customMetadata.originalFilename,
    });
  }
  return {
    drops,
    cursor: page.truncated ? page.cursor : null,
  };
}

export async function deleteDrop<
  Kind extends DropKind,
  ContentType extends string,
>(
  store: R2Bucket,
  descriptor: DropDescriptor<Kind, ContentType>,
  opaqueId: OpaqueId,
): Promise<DeletedDrop | undefined> {
  const key = dropKey(descriptor, opaqueId);
  const current = await store.head(key);
  if (current?.customMetadata?.kind !== descriptor.kind) {
    return undefined;
  }
  const owner = credentialIdSchema.safeParse(
    current.customMetadata.creatorCredentialId,
  );
  const retention = retentionSchema.safeParse(current.customMetadata.retention);
  await store.delete(key);
  return {
    owner: owner.success ? owner.data : "unknown",
    retention: retention.success ? retention.data : "unknown",
    size: current.size,
  };
}

export interface DeletedDrop {
  readonly owner: CredentialId | "unknown";
  readonly retention: Retention | "unknown";
  readonly size: number;
}

export interface DropUploadResponse<
  Kind extends DropKind,
  ContentType extends string,
> {
  readonly contentType: ContentType;
  readonly etag: string;
  readonly expiresAt: string | null;
  readonly kind: Kind;
  readonly retention: Retention;
  readonly size: number;
  readonly url: string;
}

interface DropWriteState<ContentType extends string> {
  readonly contentType: ContentType;
  readonly expiresAt: string | null;
  readonly retention: Retention;
  readonly size: number;
  readonly writeEtag: string;
}

interface StoredDropMetadata<ContentType extends string> {
  readonly contentType: ContentType;
  readonly credentialId: CredentialId;
  readonly originalFilename: string;
  readonly retention: Retention;
  readonly writeEtag: string;
}

type DropWriteAuthorization<T extends R2Object, ContentType extends string> =
  | {
      readonly status: "authorized";
      readonly current: T;
      readonly metadata: StoredDropMetadata<ContentType>;
    }
  | { readonly status: "forbidden" }
  | { readonly status: "missing" }
  | { readonly status: "stale" };

function randomOpaqueId(): OpaqueId {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const base64 = btoa(String.fromCharCode(...bytes));
  return opaqueIdSchema.parse(
    base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
  );
}

function randomWriteEtag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const value = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `"${value}"`;
}

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

function dropKey(descriptor: DropDescriptor<DropKind, string>, opaqueId: OpaqueId): string {
  return `${descriptor.kind}s/${opaqueId}`;
}

function dropCustomMetadata<Kind extends DropKind, ContentType extends string>(
  descriptor: DropDescriptor<Kind, ContentType>,
  credentialId: CredentialId,
  originalFilename: string,
  state: DropWriteState<ContentType>,
): Record<string, string> {
  return {
    creatorCredentialId: credentialId,
    originalFilename,
    kind: descriptor.kind,
    detectedType: state.contentType,
    size: String(state.size),
    retention: state.retention,
    ...(state.expiresAt === null ? {} : { expiresAt: state.expiresAt }),
    writeEtag: state.writeEtag,
  };
}

function dropUploadResponse<Kind extends DropKind, ContentType extends string>(
  descriptor: DropDescriptor<Kind, ContentType>,
  opaqueId: OpaqueId,
  publicOrigin: string,
  state: DropWriteState<ContentType>,
): DropUploadResponse<Kind, ContentType> {
  return {
    url: new URL(`/${descriptor.kind}s/${opaqueId}`, publicOrigin).href,
    kind: descriptor.kind,
    contentType: state.contentType,
    size: state.size,
    retention: state.retention,
    expiresAt: state.expiresAt,
    etag: state.writeEtag,
  };
}

function authorizeDropWrite<
  T extends R2Object,
  Kind extends DropKind,
  ContentType extends string,
>(
  current: T | null,
  descriptor: DropDescriptor<Kind, ContentType>,
  credentialId: CredentialId,
  observedEtag: string,
): DropWriteAuthorization<T, ContentType> {
  if (current === null || current.customMetadata?.kind !== descriptor.kind) {
    return { status: "missing" };
  }
  const metadata: StoredDropMetadata<ContentType> = {
    contentType: descriptor.parseContentType(current.customMetadata.detectedType),
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

async function waitForNextUploadTime(uploaded: Date): Promise<void> {
  const delay = uploaded.getTime() + 1 - Date.now();
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

export interface CreateDropInput<ContentType extends string> {
  readonly body: Blob;
  readonly contentType: ContentType;
  readonly credentialId: CredentialId;
  readonly originalFilename: string;
  readonly publicOrigin: string;
  readonly retention: Retention;
}

export async function createDrop<Kind extends DropKind, ContentType extends string>(
  store: R2Bucket,
  descriptor: DropDescriptor<Kind, ContentType>,
  input: CreateDropInput<ContentType>,
): Promise<DropUploadResponse<Kind, ContentType>> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const opaqueId = randomOpaqueId();
    const state: DropWriteState<ContentType> = {
      contentType: input.contentType,
      expiresAt: nextExpiresAt(input.retention),
      retention: input.retention,
      size: input.body.size,
      writeEtag: randomWriteEtag(),
    };
    const object = await store.put(dropKey(descriptor, opaqueId), input.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        cacheControl: "no-store",
        contentDisposition: "inline",
        contentType: input.contentType,
      },
      customMetadata: dropCustomMetadata(
        descriptor,
        input.credentialId,
        input.originalFilename,
        state,
      ),
    });
    if (object !== null) {
      return dropUploadResponse(descriptor, opaqueId, input.publicOrigin, {
        ...state,
        size: object.size,
      });
    }
  }
  throw new Error("Could not allocate an Opaque ID after repeated collisions");
}

export interface ReplaceDropInput<ContentType extends string>
  extends Omit<CreateDropInput<ContentType>, "retention"> {
  readonly observedEtag: string;
  readonly opaqueId: OpaqueId;
  readonly retention: Retention | undefined;
}

export type ReplaceDropResult<Kind extends DropKind, ContentType extends string> =
  | { readonly status: "forbidden" }
  | { readonly status: "missing" }
  | { readonly status: "stale" }
  | {
      readonly status: "replaced";
      readonly response: DropUploadResponse<Kind, ContentType>;
    };

export async function replaceDrop<Kind extends DropKind, ContentType extends string>(
  store: R2Bucket,
  descriptor: DropDescriptor<Kind, ContentType>,
  input: ReplaceDropInput<ContentType>,
): Promise<ReplaceDropResult<Kind, ContentType>> {
  const key = dropKey(descriptor, input.opaqueId);
  const current = await store.head(key);
  const authorization = authorizeDropWrite(
    current,
    descriptor,
    input.credentialId,
    input.observedEtag,
  );
  if (authorization.status !== "authorized") {
    return authorization;
  }
  const retention = input.retention ?? authorization.metadata.retention;
  const state: DropWriteState<ContentType> = {
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
    customMetadata: dropCustomMetadata(
      descriptor,
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
    response: dropUploadResponse(descriptor, input.opaqueId, input.publicOrigin, {
      ...state,
      size: object.size,
    }),
  };
}

export interface ChangeDropRetentionInput {
  readonly credentialId: CredentialId;
  readonly observedEtag: string;
  readonly opaqueId: OpaqueId;
  readonly publicOrigin: string;
  readonly retention: Retention;
}

export type ChangeDropRetentionResult<
  Kind extends DropKind,
  ContentType extends string,
> =
  | { readonly status: "forbidden" }
  | { readonly status: "missing" }
  | { readonly status: "stale" }
  | {
      readonly status: "updated";
      readonly response: DropUploadResponse<Kind, ContentType>;
    };

export async function changeDropRetention<
  Kind extends DropKind,
  ContentType extends string,
>(
  store: R2Bucket,
  descriptor: DropDescriptor<Kind, ContentType>,
  input: ChangeDropRetentionInput,
): Promise<ChangeDropRetentionResult<Kind, ContentType>> {
  const key = dropKey(descriptor, input.opaqueId);
  const current = await store.get(key);
  const authorization = authorizeDropWrite(
    current,
    descriptor,
    input.credentialId,
    input.observedEtag,
  );
  if (authorization.status !== "authorized") {
    return authorization;
  }
  const state: DropWriteState<ContentType> = {
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
    customMetadata: dropCustomMetadata(
      descriptor,
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
    response: dropUploadResponse(descriptor, input.opaqueId, input.publicOrigin, {
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
    // The listed ETag was checked above. Upload time makes the write
    // version-exact even when identical content produces a recurring ETag.
    onlyIf: exactUploadTime(candidate.uploaded),
  });
  return tombstone !== null;
}

export async function sweepExpiredDrops(
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

export type ByteRange = {
  readonly offset: number;
  readonly length: number;
};

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

function publicDropHeaders(
  object: R2Object,
  descriptor: DropDescriptor<DropKind, string>,
): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "no-store");
  headers.set("etag", object.httpEtag);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  for (const [name, value] of Object.entries(descriptor.publicHeaders ?? {})) {
    headers.set(name, value);
  }
  return headers;
}

export async function serveDrop<Kind extends DropKind, ContentType extends string>(
  store: R2Bucket,
  descriptor: DropDescriptor<Kind, ContentType>,
  opaqueId: OpaqueId,
  method: "GET" | "HEAD",
  requestHeaders: Headers,
): Promise<Response> {
  const key = dropKey(descriptor, opaqueId);
  const head = await store.head(key);
  if (head === null) {
    return new Response(null, { status: 404 });
  }
  const headers = publicDropHeaders(head, descriptor);
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
