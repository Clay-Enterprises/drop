import {
  credentialIdSchema,
  type CredentialId,
} from "../shared/upload-keys.ts";
import {
  type DocUploadResponse,
  type DocContentType,
} from "../shared/docs.ts";
import {
  opaqueIdSchema,
  type OpaqueId,
  type Retention,
} from "../shared/files.ts";
import { matchesEtag, parseByteRange } from "./files.ts";

export const maxDocSize = 512 * 1024;
export const docContentType: DocContentType = "text/html; charset=utf-8";
export const docContentSecurityPolicy =
  "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data: https:; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src data: https:; media-src data: https:; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'; sandbox allow-scripts";

const forbiddenElements = new Set([
  "applet",
  "base",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "object",
]);

const mediaUrlAttributes = new Set([
  "background",
  "poster",
  "src",
  "xlink:href",
]);

const forbiddenScriptCapabilities = [
  /\b(?:localStorage|sessionStorage|indexedDB|cookieStore|caches)\b/,
  /\bdocument\s*\.\s*cookie\b/,
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|WebTransport|RTCPeerConnection)\b/,
  /\bnavigator\s*\.\s*(?:sendBeacon|serviceWorker)\b/,
  /\b(?:Worker|SharedWorker)\s*\(/,
  /\b(?:window|globalThis|self)\s*\.\s*open\s*\(/,
  /(?:^|[^.\w])open\s*\(/,
  /\b(?:eval|Function)\s*\(/,
  /\bimport\s*\(/,
] as const;

class InvalidDoc extends Error {}

function isPrivateHostname(hostnameInput: string): boolean {
  const hostname = hostnameInput.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "::" ||
    hostname === "::1" ||
    /^(?:fc|fd|fe[89ab])/i.test(hostname)
  ) {
    return true;
  }

  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function validateRemoteUrl(valueInput: string, allowData: boolean): void {
  const value = valueInput.trim();
  if (allowData && /^data:/i.test(value)) {
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidDoc();
  }
  if (url.protocol !== "https:" || isPrivateHostname(url.hostname)) {
    throw new InvalidDoc();
  }
}

function validateCss(css: string): void {
  if (/@import\b/i.test(css)) {
    throw new InvalidDoc();
  }
  for (const match of css.matchAll(/url\(\s*([^)]+?)\s*\)/gi)) {
    const submitted = match[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (submitted === undefined || submitted.startsWith("#")) {
      continue;
    }
    validateRemoteUrl(submitted, true);
  }
}

function validateScript(script: string): void {
  if (forbiddenScriptCapabilities.some((capability) => capability.test(script))) {
    throw new InvalidDoc();
  }
}

function validateElement(element: Element): void {
  const tagName = element.tagName.toLowerCase();
  if (forbiddenElements.has(tagName)) {
    throw new InvalidDoc();
  }

  for (const attribute of element.attributes) {
    const name = attribute[0]?.toLowerCase();
    const value = attribute[1] ?? "";
    if (
      name === undefined ||
      name.startsWith("on") ||
      name === "formaction" ||
      name === "ping" ||
      name === "srcdoc"
    ) {
      throw new InvalidDoc();
    }
    if (name === "style") {
      validateCss(value);
    }
    if (mediaUrlAttributes.has(name)) {
      if (tagName === "script") {
        throw new InvalidDoc();
      }
      validateRemoteUrl(value, true);
    }
    if (name === "srcset") {
      for (const candidate of value.split(",")) {
        const url = candidate.trim().split(/\s+/, 1)[0];
        if (url !== undefined && url !== "") {
          validateRemoteUrl(url, true);
        }
      }
    }
    if (name === "href") {
      if (tagName === "link") {
        throw new InvalidDoc();
      }
      if (!value.trim().startsWith("#")) {
        validateRemoteUrl(value, tagName !== "a");
      }
    }
  }

  if (
    tagName === "meta" &&
    element.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh"
  ) {
    throw new InvalidDoc();
  }
  if (tagName === "script") {
    const type = element.getAttribute("type")?.trim().toLowerCase();
    if (type === "module") {
      throw new InvalidDoc();
    }
  }
}

/** Validates the browser-visible Doc contract without rewriting submitted HTML. */
export async function validateDocHtml(html: string): Promise<boolean> {
  let script = "";
  let style = "";
  try {
    const rewritten = new HTMLRewriter()
      .on("*", { element: validateElement })
      .on("script", {
        element(element) {
          script = "";
          element.onEndTag(() => validateScript(script));
        },
        text(text) {
          script += text.text;
        },
      })
      .on("style", {
        element(element) {
          style = "";
          element.onEndTag(() => validateCss(style));
        },
        text(text) {
          style += text.text;
        },
      })
      .transform(
        new Response(html, {
          headers: { "content-type": docContentType },
        }),
      );
    await rewritten.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

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

export interface CreateDocInput {
  readonly body: Blob;
  readonly credentialId: CredentialId;
  readonly originalFilename: string;
  readonly publicOrigin: string;
  readonly retention: Retention;
}

export async function createDoc(
  store: R2Bucket,
  input: CreateDocInput,
): Promise<DocUploadResponse> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const opaqueId = randomOpaqueId();
    const etag = randomWriteEtag();
    const expiresAt = nextExpiresAt(input.retention);
    const object = await store.put(`docs/${opaqueId}`, input.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        cacheControl: "no-store",
        contentDisposition: "inline",
        contentType: docContentType,
      },
      customMetadata: {
        creatorCredentialId: input.credentialId,
        originalFilename: input.originalFilename,
        kind: "doc",
        detectedType: docContentType,
        size: String(input.body.size),
        retention: input.retention,
        ...(expiresAt === null ? {} : { expiresAt }),
        writeEtag: etag,
      },
    });
    if (object === null) {
      continue;
    }

    return {
      url: new URL(`/docs/${opaqueId}`, input.publicOrigin).href,
      kind: "doc",
      contentType: docContentType,
      size: object.size,
      retention: input.retention,
      expiresAt,
      etag,
    };
  }

  throw new Error("Could not allocate an Opaque ID after repeated collisions");
}

type StoredDocMetadata = {
  readonly credentialId: CredentialId;
  readonly originalFilename: string;
  readonly retention: Retention;
  readonly writeEtag: string;
};

type DocWriteAuthorization<T extends R2Object> =
  | {
      readonly status: "authorized";
      readonly current: T;
      readonly metadata: StoredDocMetadata;
    }
  | { readonly status: "forbidden" }
  | { readonly status: "missing" }
  | { readonly status: "stale" };

function authorizeDocWrite<T extends R2Object>(
  current: T | null,
  credentialId: CredentialId,
  observedEtag: string,
): DocWriteAuthorization<T> {
  if (current === null || current.customMetadata?.kind !== "doc") {
    return { status: "missing" };
  }
  const metadata: StoredDocMetadata = {
    credentialId: credentialIdSchema.parse(
      current.customMetadata.creatorCredentialId,
    ),
    originalFilename: current.customMetadata.originalFilename ?? "",
    retention: (
      ["7d", "30d", "90d", "keep"] as const
    ).find((retention) => retention === current.customMetadata?.retention) ?? "keep",
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

function exactUploadTime(uploaded: Date): R2Conditional {
  const time = uploaded.getTime();
  return {
    uploadedAfter: new Date(time - 1),
    uploadedBefore: new Date(time + 1),
    secondsGranularity: false,
  };
}

async function waitForNextUploadTime(uploaded: Date): Promise<void> {
  const delay = uploaded.getTime() + 1 - Date.now();
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function docUploadResponse(
  opaqueId: OpaqueId,
  publicOrigin: string,
  size: number,
  retention: Retention,
  expiresAt: string | null,
  etag: string,
): DocUploadResponse {
  return {
    url: new URL(`/docs/${opaqueId}`, publicOrigin).href,
    kind: "doc",
    contentType: docContentType,
    size,
    retention,
    expiresAt,
    etag,
  };
}

export interface ReplaceDocInput {
  readonly body: Blob;
  readonly credentialId: CredentialId;
  readonly observedEtag: string;
  readonly opaqueId: OpaqueId;
  readonly originalFilename: string;
  readonly publicOrigin: string;
  readonly retention: Retention | undefined;
}

export type ReplaceDocResult =
  | { readonly status: "forbidden" }
  | { readonly status: "missing" }
  | { readonly status: "stale" }
  | { readonly status: "replaced"; readonly response: DocUploadResponse };

export async function replaceDoc(
  store: R2Bucket,
  input: ReplaceDocInput,
): Promise<ReplaceDocResult> {
  const key = `docs/${input.opaqueId}`;
  const current = await store.head(key);
  const authorization = authorizeDocWrite(
    current,
    input.credentialId,
    input.observedEtag,
  );
  if (authorization.status !== "authorized") {
    return authorization;
  }

  const retention = input.retention ?? authorization.metadata.retention;
  const expiresAt = nextExpiresAt(retention);
  const etag = randomWriteEtag();
  await waitForNextUploadTime(authorization.current.uploaded);
  const object = await store.put(key, input.body, {
    onlyIf: exactUploadTime(authorization.current.uploaded),
    httpMetadata: {
      cacheControl: "no-store",
      contentDisposition: "inline",
      contentType: docContentType,
    },
    customMetadata: {
      creatorCredentialId: input.credentialId,
      originalFilename: input.originalFilename,
      kind: "doc",
      detectedType: docContentType,
      size: String(input.body.size),
      retention,
      ...(expiresAt === null ? {} : { expiresAt }),
      writeEtag: etag,
    },
  });
  if (object === null) {
    return { status: "stale" };
  }
  return {
    status: "replaced",
    response: docUploadResponse(
      input.opaqueId,
      input.publicOrigin,
      object.size,
      retention,
      expiresAt,
      etag,
    ),
  };
}

export interface ChangeDocRetentionInput {
  readonly credentialId: CredentialId;
  readonly observedEtag: string;
  readonly opaqueId: OpaqueId;
  readonly publicOrigin: string;
  readonly retention: Retention;
}

export type ChangeDocRetentionResult =
  | { readonly status: "forbidden" }
  | { readonly status: "missing" }
  | { readonly status: "stale" }
  | { readonly status: "updated"; readonly response: DocUploadResponse };

export async function changeDocRetention(
  store: R2Bucket,
  input: ChangeDocRetentionInput,
): Promise<ChangeDocRetentionResult> {
  const key = `docs/${input.opaqueId}`;
  const current = await store.get(key);
  const authorization = authorizeDocWrite(
    current,
    input.credentialId,
    input.observedEtag,
  );
  if (authorization.status !== "authorized") {
    return authorization;
  }

  const expiresAt = nextExpiresAt(input.retention);
  const etag = randomWriteEtag();
  await waitForNextUploadTime(authorization.current.uploaded);
  const object = await store.put(key, authorization.current.body, {
    onlyIf: exactUploadTime(authorization.current.uploaded),
    httpMetadata: authorization.current.httpMetadata,
    customMetadata: {
      creatorCredentialId: authorization.metadata.credentialId,
      originalFilename: authorization.metadata.originalFilename,
      kind: "doc",
      detectedType: docContentType,
      size: String(authorization.current.size),
      retention: input.retention,
      ...(expiresAt === null ? {} : { expiresAt }),
      writeEtag: etag,
    },
  });
  if (object === null) {
    return { status: "stale" };
  }
  return {
    status: "updated",
    response: docUploadResponse(
      input.opaqueId,
      input.publicOrigin,
      object.size,
      input.retention,
      expiresAt,
      etag,
    ),
  };
}

function publicDocHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy", docContentSecurityPolicy);
  headers.set("etag", object.httpEtag);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return headers;
}

export async function serveDoc(
  store: R2Bucket,
  opaqueId: OpaqueId,
  method: "GET" | "HEAD",
  requestHeaders: Headers,
): Promise<Response> {
  const key = `docs/${opaqueId}`;
  const head = await store.head(key);
  if (head === null) {
    return new Response(null, { status: 404 });
  }

  const headers = publicDocHeaders(head);
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
