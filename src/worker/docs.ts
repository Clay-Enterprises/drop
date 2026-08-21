import {
  parse as parseScript,
  type AnyNode as ScriptNode,
  type Expression,
  type MemberExpression,
} from "acorn";
import { fullAncestor as walkScript } from "acorn-walk";
import { parse as parseCss, walk as walkCss } from "css-tree";
import { analyze as analyzeScriptScopes } from "eslint-scope";

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
  "FontFace",
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
  "frames",
  "globalThis",
  "indexedDB",
  "localStorage",
  "location",
  "open",
  "opener",
  "parent",
  "sendBeacon",
  "serviceWorker",
  "sessionStorage",
  "self",
  "top",
  "window",
]);

const forbiddenScriptMembers = new Set([
  ...forbiddenScriptIdentifiers,
  "__proto__",
  "__lookupGetter__",
  "__lookupSetter__",
  "addRule",
  "assign",
  "attributes",
  "caches",
  "constructor",
  "cssText",
  "cookie",
  "cookieStore",
  "createContextualFragment",
  "createRange",
  "defineProperties",
  "defineProperty",
  "defaultView",
  "execCommand",
  "fetch",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getPrototypeOf",
  "getAttributeNode",
  "getAttributeNodeNS",
  "indexedDB",
  "innerHTML",
  "insertAdjacentHTML",
  "insertNode",
  "insertRule",
  "localStorage",
  "location",
  "open",
  "outerHTML",
  "prototype",
  "replaceSync",
  "sendBeacon",
  "serviceWorker",
  "sheet",
  "sessionStorage",
  "setAttributeNode",
  "setAttributeNodeNS",
  "setHTML",
  "setHTMLUnsafe",
  "setPrototypeOf",
  "styleSheets",
  "storage",
  "storageBuckets",
  "view",
  "write",
  "writeln",
]);

const inspectedScriptMethods = new Set([
  "click",
  "createElement",
  "createElementNS",
  "dispatchEvent",
  "setAttribute",
  "setAttributeNS",
  "setProperty",
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

const scriptedCssPropertyNames = new Set([
  "backdropFilter",
  "backgroundImage",
  "borderImage",
  "borderImageSource",
  "clipPath",
  "content",
  "cursor",
  "fill",
  "filter",
  "listStyle",
  "listStyleImage",
  "marker",
  "markerEnd",
  "markerMid",
  "markerStart",
  "mask",
  "maskImage",
  "offsetPath",
  "shapeOutside",
  "stroke",
  "webkitBorderImage",
  "webkitFilter",
  "webkitMaskImage",
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
  rejectInvalidSyntax = true,
): void {
  const ast = parseCss(css, {
    context,
    parseCustomProperty: true,
    onParseError() {
      if (rejectInvalidSyntax) {
        throw new InvalidDoc();
      }
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
        decodeCssIdentifier(this.function.name)
          .toLowerCase()
          .replace(/^-(?:moz|ms|o|webkit)-/, ""),
      )
    ) {
      if (!allowRemoteMedia) {
        throw new InvalidDoc();
      }
      validateRemoteUrl(node.value, true);
    }
  });
}

function staticString(
  expression: Expression | undefined,
  staticStrings?: WeakMap<object, string>,
): string | undefined {
  if (expression?.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }
  if (expression?.type === "TemplateLiteral" && expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? undefined;
  }
  if (expression?.type === "Identifier") {
    return staticStrings?.get(expression);
  }
  return undefined;
}

function selectedElementName(
  selector: string,
  elementsById: ReadonlyMap<string, string>,
): string | undefined {
  const elementNames = selector.split(",").map((group) => {
    const terminal = group.trim().split(/[\s>+~]+/).at(-1) ?? "";
    const tagName = terminal.match(/^([a-z][a-z0-9-]*)(?=$|[#.:[\]])/i)?.[1];
    if (tagName !== undefined) {
      return tagName.toLowerCase();
    }
    const id = terminal.match(/^#([^#.:[\]]+)/)?.[1];
    return id === undefined ? undefined : elementsById.get(id);
  });
  const [first] = elementNames;
  if (
    first !== undefined &&
    elementNames.every((elementName) => elementName === first)
  ) {
    return first;
  }
  return undefined;
}

function knownElementName(
  expression: Expression | undefined,
  staticStrings: WeakMap<object, string>,
  knownElements: WeakMap<object, string>,
  elementsById: ReadonlyMap<string, string>,
): string | undefined {
  if (expression?.type === "Identifier") {
    return knownElements.get(expression);
  }
  if (expression?.type === "MemberExpression" && expression.object.type !== "Super") {
    if (
      expression.object.type === "Identifier" &&
      expression.object.name === "document"
    ) {
      const name = memberName(expression);
      if (name === "body" || name === "head") {
        return name;
      }
      if (name === "documentElement") {
        return "html";
      }
    }
    const collectionName = knownElementName(
      expression.object,
      staticStrings,
      knownElements,
      elementsById,
    );
    if (collectionName?.endsWith("[]") && memberName(expression) === "#numeric") {
      return collectionName.slice(0, -2);
    }
    return undefined;
  }
  if (expression?.type !== "CallExpression" || expression.callee.type !== "MemberExpression") {
    return undefined;
  }
  const method = memberName(expression.callee);
  if (method === "cloneNode" && expression.callee.object.type !== "Super") {
    return knownElementName(
      expression.callee.object,
      staticStrings,
      knownElements,
      elementsById,
    );
  }
  if (method === "createElement" || method === "createElementNS") {
    const argument = expression.arguments[method === "createElementNS" ? 1 : 0];
    return argument?.type === "SpreadElement"
      ? undefined
      : staticString(argument, staticStrings)?.toLowerCase();
  }
  if (method === "querySelector") {
    const argument = expression.arguments[0];
    const selector = argument?.type === "SpreadElement"
      ? undefined
      : staticString(argument, staticStrings);
    return selector === undefined
      ? undefined
      : selectedElementName(selector, elementsById);
  }
  if (method === "querySelectorAll" || method === "getElementsByTagName") {
    const argument = expression.arguments[0];
    const query = argument?.type === "SpreadElement"
      ? undefined
      : staticString(argument, staticStrings);
    const elementName = query === undefined
      ? undefined
      : method === "querySelectorAll"
        ? selectedElementName(query, elementsById)
        : /^[a-z][a-z0-9-]*$/i.test(query)
          ? query.toLowerCase()
          : undefined;
    return elementName === undefined ? undefined : `${elementName}[]`;
  }
  if (method === "item" && expression.callee.object.type !== "Super") {
    const collectionName = knownElementName(
      expression.callee.object,
      staticStrings,
      knownElements,
      elementsById,
    );
    return collectionName?.endsWith("[]")
      ? collectionName.slice(0, -2)
      : undefined;
  }
  if (method === "getElementById") {
    const argument = expression.arguments[0];
    const id = argument?.type === "SpreadElement"
      ? undefined
      : staticString(argument, staticStrings);
    return id === undefined ? undefined : elementsById.get(id);
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

function validateScriptMember(
  member: MemberExpression,
  parent: ScriptNode | undefined,
): void {
  const name = memberName(member);
  if (forbiddenScriptMembers.has(name ?? "")) {
    throw new InvalidDoc();
  }
  if (
    inspectedScriptMethods.has(name ?? "") &&
    (parent?.type !== "CallExpression" || parent.callee !== member)
  ) {
    throw new InvalidDoc();
  }
  if (
    name === undefined &&
    ((parent?.type === "CallExpression" && parent.callee === member) ||
      (parent?.type === "NewExpression" && parent.callee === member) ||
      (parent?.type === "AssignmentExpression" && parent.left === member) ||
      (parent?.type === "UpdateExpression" && parent.argument === member))
  ) {
    throw new InvalidDoc();
  }
}

function validateScriptGeneratedText(
  elementName: string,
  value: string,
  elementsById: ReadonlyMap<string, string>,
): void {
  if (elementName === "script") {
    validateScript(value, elementsById);
  } else {
    validateCss(value, "stylesheet", false);
  }
}

function validateScriptCall(
  node: Extract<ScriptNode, { type: "CallExpression" }>,
  unresolvedIdentifiers: WeakSet<object>,
  staticStrings: WeakMap<object, string>,
  knownElements: WeakMap<object, string>,
  elementsById: ReadonlyMap<string, string>,
): void {
  if (
    node.callee.type === "Identifier" &&
    unresolvedIdentifiers.has(node.callee) &&
    (node.callee.name === "setInterval" || node.callee.name === "setTimeout")
  ) {
    const callback = node.arguments[0];
    if (
      callback?.type === "SpreadElement" ||
      staticString(callback, staticStrings) !== undefined
    ) {
      throw new InvalidDoc();
    }
    return;
  }
  if (node.callee.type !== "MemberExpression") {
    return;
  }
  const name = memberName(node.callee);
  if (name === "click" || name === "dispatchEvent") {
    throw new InvalidDoc();
  }
  if (
    [
      "after",
      "append",
      "appendChild",
      "appendData",
      "before",
      "insertAdjacentText",
      "insertBefore",
      "insertData",
      "prepend",
      "replaceChildren",
      "replaceData",
      "replaceWith",
      "replaceWholeText",
    ].includes(name ?? "") &&
    node.callee.object.type !== "Super"
  ) {
    const textArguments =
      name === "insertAdjacentText" || name === "insertData"
        ? node.arguments.slice(1, 2)
        : name === "replaceData"
          ? node.arguments.slice(2, 3)
          : node.arguments;
    const elementName = knownElementName(
      node.callee.object,
      staticStrings,
      knownElements,
      elementsById,
    );
    if (elementName === "script" || elementName === "style") {
      for (const argument of textArguments) {
        const value = argument.type === "SpreadElement"
          ? undefined
          : staticString(argument, staticStrings);
        if (value === undefined) {
          throw new InvalidDoc();
        }
        validateScriptGeneratedText(elementName, value, elementsById);
      }
      return;
    }
    if (elementName === undefined) {
      for (const argument of textArguments) {
        const value = argument.type === "SpreadElement"
          ? undefined
          : staticString(argument, staticStrings);
        if (value === undefined) {
          throw new InvalidDoc();
        }
        validateCss(value, "stylesheet", false, false);
      }
    }
  }
  if (name === "createElement" || name === "createElementNS") {
    const nameArgument = node.arguments[name === "createElementNS" ? 1 : 0];
    const elementName = nameArgument?.type === "SpreadElement"
      ? undefined
      : staticString(nameArgument, staticStrings)?.toLowerCase();
    if (
      elementName === undefined ||
      elementName === "script" ||
      elementName === "style" ||
      forbiddenElements.has(elementName)
    ) {
      throw new InvalidDoc();
    }
    return;
  }
  if (name !== "setAttribute" && name !== "setAttributeNS" && name !== "setProperty") {
    return;
  }
  if (name === "setProperty") {
    const property = node.arguments[0];
    const value = node.arguments[1];
    const propertyName = property?.type === "SpreadElement"
      ? undefined
      : staticString(property, staticStrings);
    const propertyValue = value?.type === "SpreadElement"
      ? undefined
      : staticString(value, staticStrings);
    if (propertyName === undefined || propertyValue === undefined) {
      throw new InvalidDoc();
    }
    validateCss(`${propertyName}:${propertyValue}`, "declarationList", false);
    return;
  }
  const nameArgument = name === "setAttributeNS" ? node.arguments[1] : node.arguments[0];
  const valueArgument = name === "setAttributeNS" ? node.arguments[2] : node.arguments[1];
  const attributeName =
    nameArgument?.type === "SpreadElement"
      ? undefined
      : staticString(nameArgument, staticStrings);
  if (attributeName === undefined) {
    throw new InvalidDoc();
  }
  const normalizedAttributeName = attributeName.toLowerCase();
  if (
    normalizedAttributeName.startsWith("on") ||
    networkAttributeNames.has(normalizedAttributeName)
  ) {
    throw new InvalidDoc();
  }
  if (normalizedAttributeName === "style") {
    const style = valueArgument?.type === "SpreadElement"
      ? undefined
      : staticString(valueArgument, staticStrings);
    if (style === undefined) {
      throw new InvalidDoc();
    }
    validateCss(style, "declarationList", false);
  }
}

function validateScript(
  script: string,
  elementsById: ReadonlyMap<string, string> = new Map(),
): void {
  const ast = parseScript(script, {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  const scopeManager = analyzeScriptScopes(
    ast as unknown as import("estree").Program,
    { ecmaVersion: 2024, sourceType: "script" },
  );
  const unresolvedIdentifiers = new WeakSet<object>(
    scopeManager.globalScope?.through.map((reference) => reference.identifier),
  );
  const staticStrings = new WeakMap<object, string>();
  for (const scope of scopeManager.scopes) {
    for (const variable of scope.variables) {
      const [definition] = variable.defs;
      if (
        variable.defs.length !== 1 ||
        definition?.type !== "Variable" ||
        (definition.parent.kind !== "const" &&
          (definition.parent.kind !== "let" ||
            variable.references.some(
              (reference) => reference.isWrite() && reference.init !== true,
            ))) ||
        definition.node.init === null
      ) {
        continue;
      }
      const value = staticString(
        definition.node.init as unknown as Expression,
        staticStrings,
      );
      if (value === undefined) {
        continue;
      }
      staticStrings.set(definition.name, value);
      for (const reference of variable.references) {
        staticStrings.set(reference.identifier, value);
      }
    }
  }
  const knownElements = new WeakMap<object, string>();
  for (const scope of scopeManager.scopes) {
    for (const variable of scope.variables) {
      const [definition] = variable.defs;
      if (
        variable.defs.length !== 1 ||
        definition?.type !== "Variable" ||
        (definition.parent.kind !== "const" &&
          (definition.parent.kind !== "let" ||
            variable.references.some(
              (reference) => reference.isWrite() && reference.init !== true,
            ))) ||
        definition.node.init === null
      ) {
        continue;
      }
      const elementName = knownElementName(
        definition.node.init as unknown as Expression,
        staticStrings,
        knownElements,
        elementsById,
      );
      if (elementName === undefined) {
        continue;
      }
      knownElements.set(definition.name, elementName);
      for (const reference of variable.references) {
        knownElements.set(reference.identifier, elementName);
      }
    }
  }
  walkScript(ast, (node, _state, ancestors) => {
    const parent = ancestors.at(-2);
    if (node.type === "ImportExpression") {
      throw new InvalidDoc();
    }
    if (
      node.type === "Identifier" &&
      unresolvedIdentifiers.has(node) &&
      forbiddenScriptIdentifiers.has(node.name)
    ) {
      throw new InvalidDoc();
    }
    if (node.type === "MemberExpression") {
      validateScriptMember(node, parent);
    }
    if (node.type === "CallExpression") {
      validateScriptCall(
        node,
        unresolvedIdentifiers,
        staticStrings,
        knownElements,
        elementsById,
      );
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
        scriptedCssPropertyNames.has(name) ||
        (node.left.object.type === "MemberExpression" &&
          memberName(node.left.object) === "style")
      ) {
        const value = staticString(node.right, staticStrings);
        if (value === undefined) {
          throw new InvalidDoc();
        }
        validateCss(`${name}:${value}`, "declarationList", false);
      }
      if (
        (name === "innerText" || name === "nodeValue" || name === "textContent") &&
        node.left.object.type !== "Super"
      ) {
        const elementName = knownElementName(
          node.left.object,
          staticStrings,
          knownElements,
          elementsById,
        );
        if (elementName === "script" || elementName === "style") {
          const value = staticString(node.right, staticStrings);
          if (value === undefined) {
            throw new InvalidDoc();
          }
          validateScriptGeneratedText(elementName, value, elementsById);
        } else if (elementName === undefined) {
          const value = staticString(node.right, staticStrings);
          if (value === undefined) {
            throw new InvalidDoc();
          }
          validateCss(value, "stylesheet", false, false);
        }
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
  const elementsById = new Map<string, string>();
  const scripts: string[] = [];
  const styles: string[] = [];
  try {
    const rewritten = new HTMLRewriter()
      .on("*", {
        element(element) {
          validateElement(element);
          const id = element.getAttribute("id");
          if (id !== null && !elementsById.has(id)) {
            elementsById.set(id, element.tagName.toLowerCase());
          }
        },
      })
      .on("script", {
        element() {
          scripts.push("");
        },
        text(text) {
          const index = scripts.length - 1;
          scripts[index] = (scripts[index] ?? "") + text.text;
        },
      })
      .on("style", {
        element() {
          styles.push("");
        },
        text(text) {
          const index = styles.length - 1;
          styles[index] = (styles[index] ?? "") + text.text;
        },
      })
      .transform(
        new Response(html, {
          headers: { "content-type": docContentType },
        }),
      );
    await rewritten.arrayBuffer();
    for (const style of styles) {
      validateCss(style, "stylesheet");
    }
    for (const script of scripts) {
      validateScript(script, elementsById);
    }
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

export function listDocs(
  store: R2Bucket,
  input: ListDropsInput,
): Promise<DropInventoryPage> {
  return listDrops(store, docDescriptor, input);
}

export function deleteDoc(
  store: R2Bucket,
  opaqueId: OpaqueId,
): Promise<DeletedDrop | undefined> {
  return deleteDrop(store, docDescriptor, opaqueId);
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
