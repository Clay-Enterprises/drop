import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { fileUploadResponseSchema } from "../../src/shared/files.ts";
import {
  createdUploadKeySchema,
  type CreatedUploadKey,
} from "../../src/shared/upload-keys.ts";
import { onePixelPng } from "../fixtures.ts";
import {
  startWorkerd,
  testAdminKey,
  type WorkerdServer,
} from "../workerd.ts";

const maxFileSize = 95 * 1024 * 1024;

interface ListedContentObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpMetadata: Record<string, string>;
  readonly customMetadata: Record<string, string>;
}

async function createUploadKey(
  workerd: WorkerdServer,
): Promise<CreatedUploadKey> {
  const response = await fetch(`${workerd.url}/api/admin/keys`, {
    headers: { authorization: `Bearer ${testAdminKey}` },
    method: "POST",
  });
  return createdUploadKeySchema.parse(await response.json());
}

async function listContentObjects(
  workerd: WorkerdServer,
): Promise<ListedContentObject[]> {
  const response = await fetch(`${workerd.url}/__test/content-objects`);
  const body = (await response.json()) as {
    objects: ListedContentObject[];
  };
  return body.objects;
}

function uploadHeaders(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-disposition": 'inline; filename="misleading-name.txt"',
    "content-type": "text/plain",
  };
}

describe("File creation and public reads", () => {
  let workerd: WorkerdServer;

  beforeAll(async () => {
    workerd = await startWorkerd();
  });

  afterAll(async () => {
    await workerd.stop();
  });

  test("stores a byte-detected PNG under a suffixless Unlisted URL", async () => {
    const uploadKey = await createUploadKey(workerd);
    const response = await fetch(`${workerd.url}/api/files`, {
      body: onePixelPng,
      headers: uploadHeaders(uploadKey.key),
      method: "POST",
    });

    expect(response.status).toBe(201);
    const body = fileUploadResponseSchema.parse(await response.json());
    const url = new URL(body.url);
    expect(response.headers.get("location")).toBe(url.href);
    expect(url.origin).toBe(workerd.url);
    expect(url.pathname).toMatch(/^\/files\/[A-Za-z0-9_-]{32}$/);
    expect(body).toEqual({
      url: url.href,
      kind: "file",
      contentType: "image/png",
      size: onePixelPng.byteLength,
      retention: "keep",
      expiresAt: null,
      etag: expect.stringMatching(/^"[^"]+"$/),
    });

    const opaqueId = url.pathname.slice("/files/".length);
    const decodedId = Uint8Array.from(
      atob(opaqueId.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    expect(decodedId).toHaveLength(24);

    const objects = await listContentObjects(workerd);
    const object = objects.find(({ key }) => key === `files/${opaqueId}`);
    expect(object).toEqual({
      key: `files/${opaqueId}`,
      size: onePixelPng.byteLength,
      etag: body.etag,
      httpMetadata: {
        cacheControl: "no-store",
        contentDisposition: "inline",
        contentType: "image/png",
      },
      customMetadata: {
        creatorCredentialId: uploadKey.credentialId,
        originalFilename: "misleading-name.txt",
        kind: "file",
        detectedType: "image/png",
        size: String(onePixelPng.byteLength),
        retention: "keep",
      },
    });
  });

  test("serves unchanged bytes with GET, HEAD, ETags, and ranges", async () => {
    const uploadKey = await createUploadKey(workerd);
    const upload = await fetch(`${workerd.url}/api/files`, {
      body: onePixelPng,
      headers: uploadHeaders(uploadKey.key),
      method: "POST",
    });
    const created = (await upload.json()) as { url: string; etag: string };

    const response = await fetch(created.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(
      String(onePixelPng.byteLength),
    );
    expect(response.headers.get("etag")).toBe(created.etag);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(onePixelPng);

    const head = await fetch(created.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(
      String(onePixelPng.byteLength),
    );
    expect(head.headers.get("etag")).toBe(created.etag);
    expect(await head.text()).toBe("");

    const notModified = await fetch(created.url, {
      headers: { "if-none-match": created.etag },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(created.etag);
    expect(await notModified.text()).toBe("");

    const range = await fetch(created.url, {
      headers: { range: "bytes=1-7" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(
      `bytes 1-7/${onePixelPng.byteLength}`,
    );
    expect(range.headers.get("content-length")).toBe("7");
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(
      onePixelPng.slice(1, 8),
    );
  });

  test("requires an active Upload Key before storing content", async () => {
    const before = await listContentObjects(workerd);
    const missingCredential = await fetch(`${workerd.url}/api/files`, {
      body: onePixelPng,
      headers: {
        "content-disposition": 'inline; filename="file.png"',
      },
      method: "POST",
    });
    expect(missingCredential.status).toBe(401);
    expect(await missingCredential.json()).toEqual({
      error: {
        code: "invalid_credential",
        message: "The provided credential is invalid.",
      },
    });

    const revoked = await createUploadKey(workerd);
    await fetch(`${workerd.url}/api/admin/keys/${revoked.credentialId}`, {
      headers: { authorization: `Bearer ${testAdminKey}` },
      method: "DELETE",
    });
    const revokedCredential = await fetch(`${workerd.url}/api/files`, {
      body: onePixelPng,
      headers: uploadHeaders(revoked.key),
      method: "POST",
    });
    expect(revokedCredential.status).toBe(401);
    expect(await listContentObjects(workerd)).toHaveLength(before.length);
  });

  test("rejects unsupported bytes with a stable 415 without storing them", async () => {
    const uploadKey = await createUploadKey(workerd);
    const before = await listContentObjects(workerd);
    const response = await fetch(`${workerd.url}/api/files`, {
      body: "not a PNG",
      headers: {
        ...uploadHeaders(uploadKey.key),
        "content-type": "image/png",
      },
      method: "POST",
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: {
        code: "unsupported_media",
        message: "The submitted bytes are not a supported File type.",
      },
    });
    expect(await listContentObjects(workerd)).toHaveLength(before.length);
  });

  test(
    "rejects a streamed body above 95 MiB without storing it",
    async () => {
      const uploadKey = await createUploadKey(workerd);
      const before = await listContentObjects(workerd);
      let remaining = maxFileSize + 1;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (remaining === 0) {
            controller.close();
            return;
          }
          const length = Math.min(1024 * 1024, remaining);
          controller.enqueue(new Uint8Array(length));
          remaining -= length;
        },
      });

      const response = await fetch(`${workerd.url}/api/files`, {
        body,
        headers: uploadHeaders(uploadKey.key),
        method: "POST",
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: {
          code: "payload_too_large",
          message: "Files must not exceed 95 MiB.",
        },
      });
      expect(await listContentObjects(workerd)).toHaveLength(before.length);
    },
    30_000,
  );
});
