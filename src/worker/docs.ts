import {
  parse as parseScript,
  type AnyNode as ScriptNode,
  type Expression,
  type MemberExpression,
} from "acorn";
import { full as walkScript } from "acorn-walk";
import { parse as parseCss, walk as walkCss } from "css-tree";

import {
  docContentTypeSchema,
  type DocUploadResponse,
  type DocContentType,
} from "../shared/docs.ts";
import {
  type OpaqueId,
  type Retention,
} from "../shared/drops.ts";
import type { CredentialId } from "../shared/upload-keys.ts";
import {
  changeDropRetention,
  createDrop,
  replaceDrop,
  serveDrop,
  type ChangeDropRetentionResult,
  type DropDescriptor,
  type ReplaceDropResult,
} from "./drop-content.ts";

export const maxDocSize = 512 * 1024;
export const docContentType: DocContentType = "text/html; charset=utf-8";
export const docContentSecurityPolicy =
  "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data: https:; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src data: https:; media-src data: https:; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";

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

const forbiddenScriptIdentifiers = new Set([
  "Audio",
  "CacheStorage",
  "CSSStyleSheet",
  "DOMParser",
  "EventSource",
  "Function",
  "Image",
  "RTCPeerConnection",
  "Reflect",
  "SharedWorker",
  "WebAssembly",
  "WebSocket",
  "WebTransport",
  "Worker",
  "XMLHttpRequest",
  "caches",
  "cookieStore",
  "eval",
  "fetch",
  "indexedDB",
  "localStorage",
  "open",
  "sendBeacon",
  "serviceWorker",
  "sessionStorage",
]);

const forbiddenScriptMembers = new Set([
  ...forbiddenScriptIdentifiers,
  "__proto__",
  "assign",
  "caches",
  "constructor",
  "cssText",
  "cookie",
  "cookieStore",
  "defineProperties",
  "defineProperty",
  "fetch",
  "indexedDB",
  "insertAdjacentHTML",
  "insertRule",
  "localStorage",
  "open",
  "outerHTML",
  "prototype",
  "replaceSync",
  "sendBeacon",
  "serviceWorker",
  "sessionStorage",
  "setPrototypeOf",
  "write",
  "writeln",
]);

const networkAttributeNames = new Set([
  "action",
  "background",
  "data",
  "formAction",
  "formaction",
  "href",
  "ping",
  "poster",
  "src",
  "srcdoc",
  "srcset",
]);

class InvalidDoc extends Error {}

function isPrivateHostname(hostnameInput: string): boolean {
  const hostname = hostnameInput
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "::" ||
    hostname === "::1"
  ) {
    return true;
  }

  if (hostname.includes(":")) {
    const groups = parseIpv6(hostname);
    if (groups === undefined) {
      return true;
    }
    const [first = 0, second = 0, third = 0, fourth = 0, fifth = 0, sixth = 0] =
      groups;
    if (
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00
    ) {
      return true;
    }
    if (
      first === 0 &&
      second === 0 &&
      third === 0 &&
      fourth === 0 &&
      fifth === 0 &&
      sixth === 0xffff
    ) {
      return isPrivateIpv4(
        (groups[6] ?? 0) >> 8,
        groups[6] ?? 0,
        (groups[7] ?? 0) >> 8,
      );
    }
    if (
      first === 0 &&
      second === 0 &&
      third === 0 &&
      fourth === 0 &&
      fifth === 0 &&
      sixth === 0
    ) {
      return true;
    }
    return false;
  }

  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  return isPrivateIpv4(octets[0] ?? -1, octets[1] ?? -1, octets[2] ?? -1);
}

function isPrivateIpv4(
  first: number,
  secondInput: number,
  thirdInput: number,
): boolean {
  const second = secondInput & 0xff;
  const third = thirdInput & 0xff;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function parseIpv6(hostname: string): number[] | undefined {
  const halves = hostname.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const leading = halves[0] === "" ? [] : halves[0]?.split(":") ?? [];
  const trailing = halves.length === 1 || halves[1] === ""
    ? []
    : halves[1]?.split(":") ?? [];
  const missing = 8 - leading.length - trailing.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return undefined;
  }
  const submittedGroups = [
    ...leading,
    ...Array.from({ length: missing }, () => "0"),
    ...trailing,
  ];
  if (submittedGroups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return undefined;
  }
  const groups = submittedGroups.map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group))
    ? groups
    : undefined;
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

function decodeCssIdentifier(value: string): string {
  return value.replace(
    /\\([0-9a-f]{1,6})\s?|\\(.)/gi,
    (_match, hex: string | undefined, escaped: string | undefined) =>
      hex === undefined ? escaped ?? "" : String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

function validateCss(
  css: string,
  context: "declarationList" | "stylesheet",
  allowRemoteMedia = true,
): void {
  const ast = parseCss(css, {
    context,
    parseCustomProperty: true,
    onParseError() {
      throw new InvalidDoc();
    },
  });
  walkCss(ast, function (node) {
    if (
      node.type === "Atrule" &&
      decodeCssIdentifier(node.name).toLowerCase() === "import"
    ) {
      throw new InvalidDoc();
    }
    if (node.type === "Url") {
      if (!node.value.startsWith("#")) {
        if (!allowRemoteMedia) {
          throw new InvalidDoc();
        }
        validateRemoteUrl(node.value, true);
      }
      return;
    }
    if (
      node.type === "String" &&
      this.function !== null &&
      ["image", "image-set", "cross-fade"].includes(
        decodeCssIdentifier(this.function.name).toLowerCase(),
      )
    ) {
      if (!allowRemoteMedia) {
        throw new InvalidDoc();
      }
      validateRemoteUrl(node.value, true);
    }
  });
}

function staticString(expression: Expression | undefined): string | undefined {
  if (expression?.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }
  if (expression?.type === "TemplateLiteral" && expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function memberName(member: MemberExpression): string | undefined {
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  if (member.computed && member.property.type === "Literal") {
    return typeof member.property.value === "string"
      ? member.property.value
      : "#numeric";
  }
  return undefined;
}

function validateScriptMember(member: MemberExpression): void {
  const name = memberName(member);
  if (name === undefined || forbiddenScriptMembers.has(name)) {
    throw new InvalidDoc();
  }
}

function validateScriptCall(node: Extract<ScriptNode, { type: "CallExpression" }>): void {
  if (node.callee.type !== "MemberExpression") {
    return;
  }
  const name = memberName(node.callee);
  if (name === "click" || name === "dispatchEvent") {
    throw new InvalidDoc();
  }
  if (name !== "setAttribute" && name !== "setAttributeNS" && name !== "setProperty") {
    return;
  }
  if (name === "setProperty") {
    const property = node.arguments[0];
    const value = node.arguments[1];
    const propertyName = property?.type === "SpreadElement"
      ? undefined
      : staticString(property);
    const propertyValue = value?.type === "SpreadElement"
      ? undefined
      : staticString(value);
    if (propertyName === undefined || propertyValue === undefined) {
      throw new InvalidDoc();
    }
    validateCss(`${propertyName}:${propertyValue}`, "declarationList", false);
    return;
  }
  const nameArgument = name === "setAttributeNS" ? node.arguments[1] : node.arguments[0];
  const valueArgument = name === "setAttributeNS" ? node.arguments[2] : node.arguments[1];
  const attributeName =
    nameArgument?.type === "SpreadElement" ? undefined : staticString(nameArgument);
  if (attributeName === undefined) {
    throw new InvalidDoc();
  }
  if (networkAttributeNames.has(attributeName.toLowerCase())) {
    throw new InvalidDoc();
  }
  if (attributeName === "style") {
    const style = valueArgument?.type === "SpreadElement"
      ? undefined
      : staticString(valueArgument);
    if (style === undefined) {
      throw new InvalidDoc();
    }
    validateCss(style, "declarationList");
  }
}

function validateScript(script: string): void {
  const ast = parseScript(script, { ecmaVersion: "latest", sourceType: "script" });
  walkScript(ast, (node) => {
    if (node.type === "ImportExpression") {
      throw new InvalidDoc();
    }
    if (node.type === "Identifier" && forbiddenScriptIdentifiers.has(node.name)) {
      throw new InvalidDoc();
    }
    if (node.type === "MemberExpression") {
      validateScriptMember(node);
    }
    if (node.type === "CallExpression") {
      validateScriptCall(node);
    }
    if (node.type === "NewExpression") {
      if (
        node.callee.type === "Identifier" &&
        forbiddenScriptIdentifiers.has(node.callee.name)
      ) {
        throw new InvalidDoc();
      }
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression"
    ) {
      const name = memberName(node.left) ?? "";
      if (networkAttributeNames.has(name)) {
        throw new InvalidDoc();
      }
      if (
        node.left.object.type === "MemberExpression" &&
        memberName(node.left.object) === "style"
      ) {
        const value = staticString(node.right);
        if (value === undefined) {
          throw new InvalidDoc();
        }
        validateCss(`${name}:${value}`, "declarationList", false);
      }
    }
  });
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
      validateCss(value, "declarationList");
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
          element.onEndTag(() => validateCss(style, "stylesheet"));
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

const docDescriptor: DropDescriptor<"doc", DocContentType> = {
  kind: "doc",
  parseContentType: (value) => docContentTypeSchema.parse(value),
  publicHeaders: { "content-security-policy": docContentSecurityPolicy },
};

export interface CreateDocInput {
  readonly body: Blob;
  readonly credentialId: CredentialId;
  readonly originalFilename: string;
  readonly publicOrigin: string;
  readonly retention: Retention;
}

export function createDoc(
  store: R2Bucket,
  input: CreateDocInput,
): Promise<DocUploadResponse> {
  return createDrop(store, docDescriptor, {
    ...input,
    contentType: docContentType,
  });
}

export interface ReplaceDocInput extends Omit<CreateDocInput, "retention"> {
  readonly observedEtag: string;
  readonly opaqueId: OpaqueId;
  readonly retention: Retention | undefined;
}

export type ReplaceDocResult = ReplaceDropResult<"doc", DocContentType>;

export function replaceDoc(
  store: R2Bucket,
  input: ReplaceDocInput,
): Promise<ReplaceDocResult> {
  return replaceDrop(store, docDescriptor, {
    ...input,
    contentType: docContentType,
  });
}

export interface ChangeDocRetentionInput {
  readonly credentialId: CredentialId;
  readonly observedEtag: string;
  readonly opaqueId: OpaqueId;
  readonly publicOrigin: string;
  readonly retention: Retention;
}

export type ChangeDocRetentionResult = ChangeDropRetentionResult<
  "doc",
  DocContentType
>;

export function changeDocRetention(
  store: R2Bucket,
  input: ChangeDocRetentionInput,
): Promise<ChangeDocRetentionResult> {
  return changeDropRetention(store, docDescriptor, input);
}

export function serveDoc(
  store: R2Bucket,
  opaqueId: OpaqueId,
  method: "GET" | "HEAD",
  requestHeaders: Headers,
): Promise<Response> {
  return serveDrop(store, docDescriptor, opaqueId, method, requestHeaders);
}
