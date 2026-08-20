import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createdUploadKeySchema,
  type CreatedUploadKey,
} from "../../src/shared/upload-keys.ts";
import {
  startWorkerd,
  testAdminKey,
  type WorkerdServer,
} from "../workerd.ts";

const maxDocSize = 512 * 1024;

async function createUploadKey(
  workerd: WorkerdServer,
): Promise<CreatedUploadKey> {
  const response = await fetch(`${workerd.url}/api/admin/keys`, {
    headers: { authorization: `Bearer ${testAdminKey}` },
    method: "POST",
  });
  return createdUploadKeySchema.parse(await response.json());
}

function uploadHeaders(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-disposition": 'inline; filename="communication.html"',
    "content-type": "text/html; charset=utf-8",
  };
}

describe("Doc creation and public reads", () => {
  let workerd: WorkerdServer;

  beforeAll(async () => {
    workerd = await startWorkerd();
  });

  afterAll(async () => {
    await workerd.stop();
  });

  test("publishes a self-contained UTF-8 Doc at an Unlisted URL", async () => {
    const uploadKey = await createUploadKey(workerd);
    const html = "<!doctype html><title>Hello</title><h1>Hello, world</h1>";

    const response = await fetch(`${workerd.url}/api/docs`, {
      body: html,
      headers: uploadHeaders(uploadKey.key),
      method: "POST",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      contentType: string;
      etag: string;
      expiresAt: string | null;
      kind: string;
      retention: string;
      size: number;
      url: string;
    };
    expect(body).toEqual({
      url: expect.stringMatching(
        new RegExp(`^${workerd.url}/docs/[A-Za-z0-9_-]{32}$`),
      ),
      kind: "doc",
      contentType: "text/html; charset=utf-8",
      size: new TextEncoder().encode(html).byteLength,
      retention: "keep",
      expiresAt: null,
      etag: expect.stringMatching(/^"[^"]+"$/),
    });
    expect(response.headers.get("location")).toBe(body.url);

    const publicResponse = await fetch(body.url);
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(await publicResponse.text()).toBe(html);
  });

  test("accepts the Doc capabilities allowed by the browser policy", async () => {
    const uploadKey = await createUploadKey(workerd);
    const html = `<!doctype html>
<html>
  <head>
    <style id="dynamic-style">body { color: white; background-image: url(data:image/png;base64,AA==) }</style>
  </head>
  <body>
    <svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>
    <img src="data:image/png;base64,AA==" alt="Data image">
    <video src="https://cdn.example.com/demo.mp4" controls></video>
    <a href="https://example.com/details" target="_blank">Details</a>
    <div id="status">Clone me</div>
    <pre></pre>
    <script>const fetch = "ready"; const values = [fetch]; const index = 0; const tag = "span"; let status = document.getElementById("status"); document.body.append(document.createElement(tag)); document.body.append(document.querySelector("div").cloneNode(true)); status.textContent = values[index]; document.querySelector("pre").textContent = "body{background:url(https://example.com/example.png)}"; document.getElementById("dynamic-style").append("p { color: white }"); document.querySelector("a")?.classList.add(values[index]);</script>
  </body>
</html>`;

    const response = await fetch(`${workerd.url}/api/docs`, {
      body: html,
      headers: uploadHeaders(uploadKey.key),
      method: "POST",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { url: string };
    const publicResponse = await fetch(body.url);
    expect(publicResponse.headers.get("cache-control")).toBe("no-store");
    expect(publicResponse.headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
    expect(publicResponse.headers.get("referrer-policy")).toBe("no-referrer");
    expect(publicResponse.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
    expect(publicResponse.headers.get("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data: https:; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src data: https:; media-src data: https:; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
    );
    expect(await publicResponse.text()).toBe(html);
  });

  test("rejects every forbidden Doc capability with a content-free 422", async () => {
    const uploadKey = await createUploadKey(workerd);
    const forbiddenDocs = [
      ["external scripts", '<script src="https://example.com/app.js"></script>'],
      ["module scripts", '<script type="module">export default 1</script>'],
      ["event handlers", '<button onclick="alert(1)">Open</button>'],
      ["JavaScript URLs", '<a href="javascript:alert(1)">Open</a>'],
      ["forms", '<form action="https://example.com"><input></form>'],
      ["frames", '<iframe src="https://example.com"></iframe>'],
      ["embeds", '<embed src="https://example.com/demo.pdf">'],
      ["objects", '<object data="https://example.com/demo.pdf"></object>'],
      ["applets", '<applet code="Demo.class"></applet>'],
      [
        "meta refresh",
        '<meta http-equiv="refresh" content="0; url=https://example.com">',
      ],
      [
        "linked CSS",
        '<link rel="stylesheet" href="https://example.com/app.css">',
      ],
      ["local paths", '<img src="./private.png" alt="Private">'],
      [
        "private-network URLs",
        '<img src="https://127.0.0.1/private.png" alt="Private">',
      ],
      [
        "private-network hostnames with a trailing dot",
        '<img src="https://localhost./private.png" alt="Private">',
      ],
      [
        "IPv4-mapped private IPv6 URLs",
        '<img src="https://[::ffff:127.0.0.1]/private.png" alt="Private">',
      ],
      [
        "IPv6 multicast URLs",
        '<img src="https://[ff02::1]/private.png" alt="Private">',
      ],
      ["storage", "<script>localStorage.setItem('token', 'secret')</script>"],
      [
        "scripted network requests",
        "<script>fetch('https://example.com/private')</script>",
      ],
      ["workers", "<script>new Worker('data:text/javascript,')</script>"],
      [
        "script-created popups",
        "<script>window.open('https://example.com')</script>",
      ],
      [
        "constructed network API access",
        "<script>globalThis['fe' + 'tch']('https://example.com')</script>",
      ],
      [
        "script-created media requests",
        "<script>new Image().src = 'https://example.com/pixel.png'</script>",
      ],
      [
        "aliased media mutation methods",
        "<img><script>const image = document.querySelector('img'); const set = image.setAttribute; set.call(image, 'src', 'https://example.com/pixel.png')</script>",
      ],
      [
        "attribute-node media mutations",
        '<img src="data:image/png;base64,AA=="><script>document.querySelector("img").getAttributeNode("src").value="https://example.com/pixel.png"</script>',
      ],
      [
        "aliased scripted link activation",
        "<a href='https://example.com' target='_blank'>Open</a><script>const link = document.querySelector('a'); const activate = link.click; document.addEventListener('click', () => activate.call(link))</script>",
      ],
      [
        "reflected network API access",
        "<script>Object.getOwnPropertyDescriptor(globalThis, 'fetch').value('https://example.com')</script>",
      ],
      [
        "scripted navigation",
        "<script>document.location = 'https://example.com'</script>",
      ],
      [
        "bare scripted navigation",
        "<script>location = 'https://example.com'</script>",
      ],
      [
        "script-created markup",
        '<script>document.body.innerHTML = "<img src=https://example.com/pixel.png>"</script>',
      ],
      [
        "script-created executable elements",
        '<script>const script = document.createElement("script"); script.textContent = `const image=document.createElement("img");image.src="https://example.com/pixel.png"`; document.body.append(script)</script>',
      ],
      [
        "script-created forbidden elements",
        '<script>document.body.append(document.createElement("form"))</script>',
      ],
      [
        "script-created event handlers",
        '<button id="open">Open</button><script>document.querySelector("#open").setAttribute("onclick", "location=\'https://example.com\'")</script>',
      ],
      [
        "string timer callbacks",
        '<script>setTimeout("location=\'https://example.com\'", 0)</script>',
      ],
      [
        "constant string timer callbacks",
        '<script>const callback = "location=\'https://example.com\'"; setTimeout(callback, 0)</script>',
      ],
      [
        "script-created CSS requests",
        '<div id="preview"></div><script>document.querySelector("#preview").setAttribute("style", "background:url(https://example.com/pixel.png)")</script>',
      ],
      [
        "script-created CSS requests through style aliases",
        '<script>const css=document.body.style; css.backgroundImage="url(https://example.com/pixel.png)"</script>',
      ],
      [
        "script-created font requests",
        '<script>new FontFace("demo", "url(https://example.com/font.woff)").load()</script>',
      ],
      [
        "origin-private file storage",
        '<script>navigator.storage.getDirectory()</script>',
      ],
      [
        "script-created style element requests",
        '<style></style><script>document.querySelector("style").textContent="body{background:url(https://example.com/pixel.png)}"</script>',
      ],
      [
        "script-created style requests through element IDs",
        '<style id="theme"></style><script>document.getElementById("theme").textContent="body{background:url(https://example.com/pixel.png)}"</script>',
      ],
      [
        "script-appended style requests",
        '<style id="theme"></style><script>document.querySelector("#theme").append("body{background:url(https://example.com/pixel.png)}")</script>',
      ],
      [
        "script-replaced style requests",
        '<style id="theme"></style><script>document.querySelector("#theme").replaceChildren("body{background:url(https://example.com/pixel.png)}")</script>',
      ],
      [
        "script-created style requests through descendant selectors",
        '<head><style></style></head><script>document.querySelector("head style").textContent="body{background:url(https://example.com/pixel.png)}"</script>',
      ],
      [
        "script-created style requests through element collections",
        '<style></style><script>const styles = document.querySelectorAll("style"); styles[0].textContent="body{background:url(https://example.com/pixel.png)}"</script>',
      ],
      [
        "script-created style requests through DOM relationships",
        '<head><style></style></head><script>document.head.firstElementChild.textContent="body{background:url(https://example.com/pixel.png)}"</script>',
      ],
      [
        "dynamic script-created style requests through DOM relationships",
        '<head><style></style></head><script>let css="body{background:url(https://example.com/pixel.png)}"; document.head.firstElementChild.textContent=css</script>',
      ],
      [
        "script-inserted adjacent style requests",
        '<style></style><script>document.querySelector("style").insertAdjacentText("beforeend", "body{background:url(https://example.com/pixel.png)}")</script>',
      ],
      [
        "script-created style requests through text node values",
        '<style>body{color:white}</style><script>document.querySelector("style").firstChild.nodeValue="body{background:url(https://example.com/pixel.png)}"</script>',
      ],
      [
        "script-created style requests through character data methods",
        '<style>body{color:white}</style><script>document.querySelector("style").firstChild.appendData("body{background:url(https://example.com/pixel.png)}")</script>',
      ],
      [
        "script-created style requests through ranges",
        '<style>body{color:white}</style><script>const range=document.createRange(); range.selectNodeContents(document.querySelector("style")); range.insertNode(document.createTextNode("body{background:url(https://example.com/pixel.png)}"))</script>',
      ],
      [
        "script-created style requests through legacy CSS rules",
        '<style>body{color:white}</style><script>document.querySelector("style").sheet.addRule("body", "background:url(https://example.com/pixel.png)")</script>',
      ],
      [
        "escaped linked CSS",
        '<style>@\\69mport "https://example.com/app.css";</style>',
      ],
      [
        "CSS private-network image sets",
        '<style>body { background: image-set("https://127.0.0.1/a.png" 1x) }</style>',
      ],
      [
        "vendor CSS private-network image sets",
        '<style>body { background: -webkit-image-set("https://127.0.0.1/a.png" 1x) }</style>',
      ],
    ] as const;

    for (const [capability, fragment] of forbiddenDocs) {
      const marker = `submitted-${capability}`;
      const response = await fetch(`${workerd.url}/api/docs`, {
        body: `<!doctype html><title>${marker}</title>${fragment}`,
        headers: uploadHeaders(uploadKey.key),
        method: "POST",
      });
      const responseText = await response.text();

      expect(response.status, capability).toBe(422);
      expect(JSON.parse(responseText), capability).toEqual({
        error: {
          code: "invalid_doc",
          message: "The submitted Doc violates the HTML communication contract.",
        },
      });
      expect(responseText, capability).not.toContain(marker);
      expect(responseText, capability).not.toContain(fragment);
    }
  });

  test("Re-drops only with the owning Upload Key and current ETag", async () => {
    const owner = await createUploadKey(workerd);
    const other = await createUploadKey(workerd);
    const firstHtml = "<!doctype html><title>First</title><h1>First</h1>";
    const createdResponse = await fetch(`${workerd.url}/api/docs`, {
      body: firstHtml,
      headers: {
        ...uploadHeaders(owner.key),
        "drop-retention": "7d",
      },
      method: "POST",
    });
    const created = (await createdResponse.json()) as {
      etag: string;
      expiresAt: string;
      retention: string;
      url: string;
    };
    const opaqueId = new URL(created.url).pathname.slice("/docs/".length);
    const apiUrl = `${workerd.url}/api/docs/${opaqueId}`;

    const forbiddenResponse = await fetch(apiUrl, {
      body: "<!doctype html><title>Wrong owner</title>",
      headers: {
        ...uploadHeaders(other.key),
        "if-match": created.etag,
      },
      method: "PUT",
    });
    expect(forbiddenResponse.status).toBe(403);

    const secondHtml = "<!doctype html><title>Second</title><h1>Second</h1>";
    const replacedResponse = await fetch(apiUrl, {
      body: secondHtml,
      headers: {
        ...uploadHeaders(owner.key),
        "if-match": created.etag,
      },
      method: "PUT",
    });
    expect(replacedResponse.status).toBe(200);
    const replaced = (await replacedResponse.json()) as {
      etag: string;
      expiresAt: string;
      retention: string;
      url: string;
    };
    expect(replaced.url).toBe(created.url);
    expect(replaced.etag).not.toBe(created.etag);
    expect(replaced.retention).toBe("7d");
    expect(new Date(replaced.expiresAt).getTime()).toBeGreaterThan(
      new Date(created.expiresAt).getTime(),
    );
    expect(await (await fetch(created.url)).text()).toBe(secondHtml);

    const staleResponse = await fetch(apiUrl, {
      body: firstHtml,
      headers: {
        ...uploadHeaders(owner.key),
        "if-match": created.etag,
      },
      method: "PUT",
    });
    expect(staleResponse.status).toBe(409);

    const changedResponse = await fetch(apiUrl, {
      body: JSON.stringify({ retention: "90d" }),
      headers: {
        authorization: `Bearer ${owner.key}`,
        "content-type": "application/json",
        "if-match": replaced.etag,
      },
      method: "PATCH",
    });
    expect(changedResponse.status).toBe(200);
    const changed = (await changedResponse.json()) as {
      etag: string;
      retention: string;
      url: string;
    };
    expect(changed).toMatchObject({
      url: created.url,
      retention: "90d",
      etag: expect.stringMatching(/^"[^"]+"$/),
    });
    expect(changed.etag).not.toBe(replaced.etag);
    expect(await (await fetch(created.url)).text()).toBe(secondHtml);
  });

  test("expires Docs through the existing retention sweep", async () => {
    const uploadKey = await createUploadKey(workerd);
    const createdResponse = await fetch(`${workerd.url}/api/docs`, {
      body: "<!doctype html><title>Temporary</title>",
      headers: {
        ...uploadHeaders(uploadKey.key),
        "drop-retention": "7d",
      },
      method: "POST",
    });
    const created = (await createdResponse.json()) as { url: string };
    const opaqueId = new URL(created.url).pathname.slice("/docs/".length);
    const expired = await fetch(
      `${workerd.url}/__test/doc-objects/${opaqueId}/expiry`,
      {
        body: JSON.stringify({ expiresAt: new Date(0).toISOString() }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(expired.status).toBe(204);

    const scheduled = await fetch(`${workerd.url}/__scheduled`);
    expect(scheduled.status).toBe(200);
    expect((await fetch(created.url)).status).toBe(404);
  });

  test("accepts the 512 KiB limit and rejects larger or non-UTF-8 Docs", async () => {
    const uploadKey = await createUploadKey(workerd);
    const prefix = "<!doctype html><title>Boundary</title>";
    const boundaryDoc = `${prefix}${"a".repeat(maxDocSize - prefix.length)}`;

    const boundaryResponse = await fetch(`${workerd.url}/api/docs`, {
      body: boundaryDoc,
      headers: uploadHeaders(uploadKey.key),
      method: "POST",
    });
    expect(boundaryResponse.status).toBe(201);
    expect((await boundaryResponse.json()) as { size: number }).toMatchObject({
      size: maxDocSize,
    });

    const invalidUtf8Response = await fetch(`${workerd.url}/api/docs`, {
      body: new Uint8Array([0x3c, 0x68, 0x31, 0x3e, 0xc3, 0x28]),
      headers: uploadHeaders(uploadKey.key),
      method: "POST",
    });
    expect(invalidUtf8Response.status).toBe(422);
    expect(await invalidUtf8Response.json()).toEqual({
      error: {
        code: "invalid_doc",
        message: "The submitted Doc violates the HTML communication contract.",
      },
    });

    let remaining = maxDocSize + 1;
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) {
          controller.close();
          return;
        }
        const length = Math.min(64 * 1024, remaining);
        controller.enqueue(new Uint8Array(length).fill(0x20));
        remaining -= length;
      },
    });
    const oversizedResponse = await fetch(`${workerd.url}/api/docs`, {
      body: oversizedBody,
      headers: uploadHeaders(uploadKey.key),
      method: "POST",
    });
    expect(oversizedResponse.status).toBe(413);
    expect(await oversizedResponse.json()).toEqual({
      error: {
        code: "payload_too_large",
        message: "Docs must not exceed 512 KiB.",
      },
    });
  });
});
