import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { onePixelPng } from "../fixtures.ts";
import {
  createdUploadKeySchema,
  type CreatedUploadKey,
} from "../../src/shared/upload-keys.ts";
import {
  startWorkerd,
  testAdminKey,
  type WorkerdServer,
} from "../workerd.ts";

const adminHeaders = {
  authorization: `Bearer ${testAdminKey}`,
};

async function createUploadKey(
  workerd: WorkerdServer,
): Promise<CreatedUploadKey> {
  const response = await fetch(`${workerd.url}/api/admin/keys`, {
    headers: adminHeaders,
    method: "POST",
  });
  return createdUploadKeySchema.parse(await response.json());
}

async function createFile(
  workerd: WorkerdServer,
  uploadKey: string,
): Promise<{ readonly url: string }> {
  const response = await fetch(`${workerd.url}/api/files`, {
    body: onePixelPng,
    headers: {
      authorization: `Bearer ${uploadKey}`,
      "content-disposition": 'inline; filename="pixel.png"',
      "drop-retention": "30d",
    },
    method: "POST",
  });
  return (await response.json()) as { readonly url: string };
}

async function createDoc(
  workerd: WorkerdServer,
  uploadKey: string,
): Promise<{ readonly url: string }> {
  const response = await fetch(`${workerd.url}/api/docs`, {
    body: "<!doctype html><title>Inventory</title>",
    headers: {
      authorization: `Bearer ${uploadKey}`,
      "content-disposition": 'inline; filename="inventory.html"',
      "drop-retention": "keep",
    },
    method: "POST",
  });
  return (await response.json()) as { readonly url: string };
}

describe("Drop administration", () => {
  let workerd: WorkerdServer;

  beforeAll(async () => {
    workerd = await startWorkerd();
  });

  afterAll(async () => {
    await workerd.stop();
  });

  test("lists a File with its safe operational metadata", async () => {
    const owner = await createUploadKey(workerd);
    const created = await createFile(workerd, owner.key);

    const response = await fetch(`${workerd.url}/api/files`, {
      headers: adminHeaders,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly cursor: string | null;
      readonly drops: ReadonlyArray<Record<string, unknown>>;
    };
    expect(body.cursor).toBeNull();
    expect(body.drops).toContainEqual({
      url: created.url,
      kind: "file",
      retention: "30d",
      owner: owner.credentialId,
      uploadedAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
      expiresAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
      size: onePixelPng.byteLength,
      contentType: "image/png",
      originalFilename: "pixel.png",
    });
  });

  test("lists a Doc with its safe operational metadata", async () => {
    const owner = await createUploadKey(workerd);
    const created = await createDoc(workerd, owner.key);

    const response = await fetch(`${workerd.url}/api/docs`, {
      headers: adminHeaders,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly drops: ReadonlyArray<Record<string, unknown>>;
    };
    expect(body.drops).toContainEqual({
      url: created.url,
      kind: "doc",
      retention: "keep",
      owner: owner.credentialId,
      uploadedAt: expect.any(String),
      expiresAt: null,
      size: new TextEncoder().encode(
        "<!doctype html><title>Inventory</title>",
      ).byteLength,
      contentType: "text/html; charset=utf-8",
      originalFilename: "inventory.html",
    });
  });

  test("cursor-paginates inventory directly from R2", async () => {
    const owner = await createUploadKey(workerd);
    const created = await Promise.all([
      createFile(workerd, owner.key),
      createFile(workerd, owner.key),
      createFile(workerd, owner.key),
    ]);
    const firstResponse = await fetch(`${workerd.url}/api/files?limit=2`, {
      headers: adminHeaders,
    });
    const first = (await firstResponse.json()) as {
      readonly cursor: string | null;
      readonly drops: ReadonlyArray<{ readonly url: string }>;
    };
    expect(first.drops).toHaveLength(2);
    expect(first.cursor).toEqual(expect.any(String));

    const listedUrls = new Set(first.drops.map(({ url }) => url));
    let cursor = first.cursor;
    while (cursor !== null) {
      const response = await fetch(
        `${workerd.url}/api/files?limit=2&cursor=${encodeURIComponent(cursor)}`,
        { headers: adminHeaders },
      );
      const page = (await response.json()) as {
        readonly cursor: string | null;
        readonly drops: ReadonlyArray<{ readonly url: string }>;
      };
      for (const drop of page.drops) listedUrls.add(drop.url);
      cursor = page.cursor;
    }
    for (const drop of created) expect(listedUrls).toContain(drop.url);
  });

  test("rejects Upload Keys for inventory", async () => {
    const uploadKey = await createUploadKey(workerd);

    for (const path of ["/api/files", "/api/docs"]) {
      const response = await fetch(`${workerd.url}${path}`, {
        headers: { authorization: `Bearer ${uploadKey.key}` },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_credential",
          message: "The provided credential is invalid.",
        },
      });
    }
  });

  test("deletes exact File and Doc URLs irreversibly", async () => {
    const owner = await createUploadKey(workerd);
    const created = await Promise.all([
      createFile(workerd, owner.key),
      createDoc(workerd, owner.key),
    ]);

    for (const drop of created) {
      const url = new URL(drop.url);
      const response = await fetch(`${workerd.url}/api${url.pathname}`, {
        headers: adminHeaders,
        method: "DELETE",
      });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect((await fetch(drop.url)).status).toBe(404);

      const missingResponse = await fetch(
        `${workerd.url}/api${url.pathname}`,
        { headers: adminHeaders, method: "DELETE" },
      );
      expect(missingResponse.status).toBe(404);
      expect(await missingResponse.json()).toEqual({
        error: {
          code: "not_found",
          message: `The ${url.pathname.startsWith("/files/") ? "File" : "Doc"} does not exist.`,
        },
      });
    }
  });

  test("rejects Upload Keys for deletion and the Admin Key for Re-drops", async () => {
    const owner = await createUploadKey(workerd);
    const created = await createFile(workerd, owner.key);
    const path = new URL(created.url).pathname;

    const deleteResponse = await fetch(`${workerd.url}/api${path}`, {
      headers: { authorization: `Bearer ${owner.key}` },
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(401);
    expect((await fetch(created.url)).status).toBe(200);

    const replaceResponse = await fetch(`${workerd.url}/api${path}`, {
      body: onePixelPng,
      headers: {
        ...adminHeaders,
        "content-disposition": 'inline; filename="replacement.png"',
        "if-match": '"irrelevant"',
      },
      method: "PUT",
    });
    expect(replaceResponse.status).toBe(401);
    expect((await fetch(created.url)).status).toBe(200);
  });

  test("lets only the Admin Key run the expiry sweep", async () => {
    const owner = await createUploadKey(workerd);
    const created = await createFile(workerd, owner.key);
    const opaqueId = new URL(created.url).pathname.slice("/files/".length);
    const seeded = await fetch(
      `${workerd.url}/__test/content-objects/${opaqueId}/expiry`,
      {
        body: JSON.stringify({ expiresAt: new Date(0).toISOString() }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(seeded.status).toBe(204);

    const unauthorized = await fetch(`${workerd.url}/api/admin/sweep`, {
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);
    expect((await fetch(created.url)).status).toBe(200);

    const swept = await fetch(`${workerd.url}/api/admin/sweep`, {
      headers: adminHeaders,
      method: "POST",
    });
    expect(swept.status).toBe(204);
    expect(await swept.text()).toBe("");
    expect((await fetch(created.url)).status).toBe(404);
  });
});
