import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  startWorkerd,
  testAdminKey,
  type WorkerdServer,
} from "../workerd.ts";

const adminHeaders = {
  authorization: `Bearer ${testAdminKey}`,
};

describe("Upload Key administration", () => {
  let workerd: WorkerdServer;

  beforeAll(async () => {
    workerd = await startWorkerd();
  });

  afterAll(async () => {
    await workerd.stop();
  });

  test("rejects missing and invalid Admin Keys with a stable error", async () => {
    for (const authorization of [undefined, "Bearer drop_a_wrong"]) {
      const response = await fetch(`${workerd.url}/api/admin/keys`, {
        headers: authorization === undefined ? {} : { authorization },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toStartWith(
        "application/json",
      );
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_credential",
          message: "The provided credential is invalid.",
        },
      });
    }
  });

  test("creates a 256-bit Upload Key", async () => {
    const response = await fetch(`${workerd.url}/api/admin/keys`, {
      headers: adminHeaders,
      method: "POST",
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      credentialId: expect.stringMatching(/^[0-9a-f]{32}$/),
      createdAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
      key: expect.stringMatching(
        /^drop_u_[0-9a-f]{32}_[0-9a-f]{64}$/,
      ),
    });

    const key = (body as { key: string }).key;
    const match = /^drop_u_([0-9a-f]{32})_([0-9a-f]{64})$/.exec(key);
    const credentialId = match?.[1];
    const secret = match?.[2];
    if (credentialId === undefined || secret === undefined) {
      throw new Error("Worker returned an invalid Upload Key");
    }
    expect((body as { credentialId: string }).credentialId).toBe(credentialId);
    expect(secret).toHaveLength(64);

    const record = (await workerd.readControlObject(
      `upload-keys/${credentialId}`,
    )) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(["createdAt", "secretHash"]);
    expect(record.createdAt).toBe((body as { createdAt: string }).createdAt);
    const secretBytes = Uint8Array.from(
      secret.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
    );
    const expectedHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", secretBytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(record.secretHash).toBe(expectedHash);
  });

  test("lists credential IDs and creation times without secrets", async () => {
    const createResponse = await fetch(`${workerd.url}/api/admin/keys`, {
      headers: adminHeaders,
      method: "POST",
    });
    const created = (await createResponse.json()) as {
      credentialId: string;
      createdAt: string;
    };

    const response = await fetch(`${workerd.url}/api/admin/keys`, {
      headers: adminHeaders,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      keys: Array<Record<string, unknown>>;
    };
    expect(body.keys).toContainEqual({
      credentialId: created.credentialId,
      createdAt: created.createdAt,
    });
    for (const key of body.keys) {
      expect(Object.keys(key).sort()).toEqual(["createdAt", "credentialId"]);
    }
  });

  test("revokes an Upload Key immediately", async () => {
    const createResponse = await fetch(`${workerd.url}/api/admin/keys`, {
      headers: adminHeaders,
      method: "POST",
    });
    const created = (await createResponse.json()) as {
      credentialId: string;
      key: string;
    };

    const authenticateResponse = await fetch(
      `${workerd.url}/__test/authenticate-upload-key`,
      { headers: { authorization: `Bearer ${created.key}` } },
    );
    expect(authenticateResponse.status).toBe(200);
    expect(await authenticateResponse.json()).toEqual({
      credentialId: created.credentialId,
    });

    const revokeResponse = await fetch(
      `${workerd.url}/api/admin/keys/${created.credentialId}`,
      { headers: adminHeaders, method: "DELETE" },
    );

    expect(revokeResponse.status).toBe(204);
    expect(await revokeResponse.text()).toBe("");

    const revokedAuthentication = await fetch(
      `${workerd.url}/__test/authenticate-upload-key`,
      { headers: { authorization: `Bearer ${created.key}` } },
    );
    expect(revokedAuthentication.status).toBe(401);
    expect(await revokedAuthentication.json()).toEqual({
      error: {
        code: "invalid_credential",
        message: "The provided credential is invalid.",
      },
    });

    const listResponse = await fetch(`${workerd.url}/api/admin/keys`, {
      headers: adminHeaders,
    });
    const listed = (await listResponse.json()) as {
      keys: Array<{ credentialId: string }>;
    };
    expect(listed.keys).not.toContainEqual(
      expect.objectContaining({ credentialId: created.credentialId }),
    );
  });
});
