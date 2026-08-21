import { createInterface } from "node:readline/promises";

import { AwsClient } from "aws4fetch";
import { z } from "zod";

import { docUploadResponseSchema } from "../src/shared/docs.ts";
import { dropInventoryPageSchema } from "../src/shared/drops.ts";
import { fileUploadResponseSchema } from "../src/shared/files.ts";
import {
  createdUploadKeySchema,
  uploadKeyListSchema,
} from "../src/shared/upload-keys.ts";

const help = `Usage: bun run verify:production

Runs destructive acceptance checks against the live Drop service, then removes
every test Drop and restores the daily cron schedule.

Required environment variables:
  DROP_ADMIN_KEY       Live Admin Key
  DROP_UPLOAD_KEY      Initial live Upload Key
  R2_ACCOUNT_ID        Cloudflare account ID
  R2_ACCESS_KEY_ID     Temporary drop-content Object Read & Write key ID
  R2_SECRET_ACCESS_KEY Temporary drop-content Object Read & Write secret

Optional environment variables:
  DROP_ORIGIN          Public origin (default: https://drop.clay.sh)
`;

if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
  console.log(help);
  process.exit(0);
}

const environmentSchema = z.object({
  DROP_ADMIN_KEY: z.string().regex(/^drop_a_[0-9a-f]{64}$/),
  DROP_ORIGIN: z.url().default("https://drop.clay.sh"),
  DROP_UPLOAD_KEY: z.string().startsWith("drop_u_"),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
});

const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

const gif = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="),
  (character) => character.charCodeAt(0),
);

const firstDoc = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Drop acceptance</title></head>
  <body style="background:#000;color:#fff"><p id="revision">first revision</p></body>
</html>`;

const secondDoc = firstDoc.replace("first revision", "second revision");

const expectedDocCsp =
  "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data: https:; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src data: https:; media-src data: https:; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function say(message: string): void {
  console.log(`  ${message}`);
}

async function responseBody(response: Response): Promise<string> {
  return (await response.text()).slice(0, 2_000);
}

async function expectStatus(
  response: Response,
  status: number,
  operation: string,
): Promise<Response> {
  if (response.status !== status) {
    throw new Error(
      `${operation} returned HTTP ${response.status}: ${await responseBody(response)}`,
    );
  }
  return response;
}

async function parseResponse<T>(
  response: Response,
  status: number,
  operation: string,
  schema: z.ZodType<T>,
): Promise<T> {
  await expectStatus(response, status, operation);
  return schema.parse(await response.json());
}

function apiPath(publicUrl: string): string {
  const url = new URL(publicUrl);
  return `/api${url.pathname}`;
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const process_ = Bun.spawn(command, { stderr: "ignore", stdout: "ignore" });
    await process_.exited;
  } catch {
    say(`open this Doc manually: ${url}`);
  }
}

async function deploySchedule(schedule: string): Promise<void> {
  const arguments_ = ["bunx", "wrangler", "deploy", "--schedules", schedule];
  const deployment = Bun.spawn(arguments_, {
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await deployment.exited;
  if (exitCode !== 0) {
    throw new Error(
      schedule === "0 0 * * *"
        ? "Could not restore the daily production schedule."
        : "Could not deploy the temporary expiry-test schedule.",
    );
  }
}

async function main(): Promise<void> {
  const environment = environmentSchema.parse(Bun.env);
  const origin = new URL(environment.DROP_ORIGIN).origin;
  const uploadHeaders = {
    Authorization: `Bearer ${environment.DROP_UPLOAD_KEY}`,
  };
  const adminHeaders = {
    Authorization: `Bearer ${environment.DROP_ADMIN_KEY}`,
  };
  const r2 = new AwsClient({
    accessKeyId: environment.R2_ACCESS_KEY_ID,
    region: "auto",
    secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
    service: "s3",
  });
  const r2Origin = `https://${environment.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const createdDrops: string[] = [];
  let disposableCredentialId: string | undefined;
  let minuteScheduleDeployed = false;

  const apiFetch = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(new URL(path, origin), init);

  try {
    say("checking that the public hostname does not list bucket contents");
    const root = await fetch(origin, { cache: "no-store" });
    assert(root.status !== 200, "The public hostname unexpectedly served a directory listing.");

    say("creating a File through the authenticated Worker route");
    const createdFile = await parseResponse(
      await apiFetch("/api/files", {
        method: "POST",
        headers: {
          ...uploadHeaders,
          "Content-Disposition": 'inline; filename="acceptance.png"',
          "Drop-Retention": "7d",
        },
        body: png,
      }),
      201,
      "File creation",
      fileUploadResponseSchema,
    );
    createdDrops.push(createdFile.url);
    assert(
      new URL(createdFile.url).origin === origin,
      "File URL uses the wrong origin.",
    );

    say("checking GET, HEAD, byte ranges, conditional reads, and public headers");
    const publicFile = await expectStatus(
      await fetch(createdFile.url, { cache: "no-store" }),
      200,
      "public File GET",
    );
    const publicEtag = publicFile.headers.get("etag");
    assert(publicEtag !== null, "Public File response omitted ETag.");
    assert(
      sameBytes(new Uint8Array(await publicFile.arrayBuffer()), png),
      "Public File bytes differ from the upload.",
    );
    for (const [name, expected] of [
      ["cache-control", "no-store"],
      ["referrer-policy", "no-referrer"],
      ["x-content-type-options", "nosniff"],
      ["x-robots-tag", "noindex, nofollow, noarchive"],
    ] as const) {
      assert(publicFile.headers.get(name) === expected, `${name} is not ${expected}.`);
    }
    assert(
      publicFile.headers.get("access-control-allow-origin") === null,
      "Public File response unexpectedly enables CORS.",
    );
    const cacheStatus = publicFile.headers.get("cf-cache-status");
    assert(
      cacheStatus === "BYPASS" || cacheStatus === "DYNAMIC",
      `Public File has unexpected Cloudflare cache status ${cacheStatus ?? "missing"}.`,
    );
    const repeatedFile = await expectStatus(
      await fetch(createdFile.url, { cache: "no-store" }),
      200,
      "repeated public File GET",
    );
    assert(
      repeatedFile.headers.get("cf-cache-status") !== "HIT",
      "Repeated public File response came from Cloudflare cache.",
    );

    const head = await expectStatus(
      await fetch(createdFile.url, { method: "HEAD", cache: "no-store" }),
      200,
      "public File HEAD",
    );
    assert(
      head.headers.get("content-length") === String(png.length),
      "HEAD has the wrong length.",
    );
    assert((await head.arrayBuffer()).byteLength === 0, "HEAD returned a response body.");

    const range = await expectStatus(
      await fetch(createdFile.url, {
        headers: { Range: "bytes=0-7" },
        cache: "no-store",
      }),
      206,
      "public File range read",
    );
    assert(
      range.headers.get("content-range") === `bytes 0-7/${png.length}`,
      "Range response is wrong.",
    );
    assert((await range.arrayBuffer()).byteLength === 8, "Range response has the wrong length.");

    await expectStatus(
      await fetch(createdFile.url, {
        headers: { "If-None-Match": publicEtag },
        cache: "no-store",
      }),
      304,
      "conditional public File read",
    );

    say("Re-dropping the File and changing its Retention Class");
    const replacedFile = await parseResponse(
      await apiFetch(apiPath(createdFile.url), {
        method: "PUT",
        headers: {
          ...uploadHeaders,
          "Content-Disposition": 'inline; filename="acceptance.gif"',
          "If-Match": createdFile.etag,
        },
        body: gif,
      }),
      200,
      "File Re-drop",
      fileUploadResponseSchema,
    );
    assert(replacedFile.url === createdFile.url, "File Re-drop changed its URL.");
    assert(
      replacedFile.contentType === "image/gif",
      "File Re-drop did not change its media type.",
    );
    const changedFile = await parseResponse(
      await apiFetch(apiPath(createdFile.url), {
        method: "PATCH",
        headers: {
          ...uploadHeaders,
          "Content-Type": "application/json",
          "If-Match": replacedFile.etag,
        },
        body: JSON.stringify({ retention: "30d" }),
      }),
      200,
      "File retention change",
      fileUploadResponseSchema,
    );
    assert(changedFile.retention === "30d", "File Retention Class did not change.");

    say("creating a Doc for the manual refresh check");
    const createdDoc = await parseResponse(
      await apiFetch("/api/docs", {
        method: "POST",
        headers: {
          ...uploadHeaders,
          "Content-Disposition": 'inline; filename="acceptance.html"',
          "Drop-Retention": "7d",
        },
        body: firstDoc,
      }),
      201,
      "Doc creation",
      docUploadResponseSchema,
    );
    createdDrops.push(createdDoc.url);
    const publicDoc = await expectStatus(
      await fetch(createdDoc.url, { cache: "no-store" }),
      200,
      "public Doc GET",
    );
    assert(
      publicDoc.headers.get("content-security-policy") === expectedDocCsp,
      "Public Doc response has the wrong Content-Security-Policy.",
    );
    assert(
      (await publicDoc.text()).includes("first revision"),
      "Public Doc has the wrong first revision.",
    );

    await openBrowser(createdDoc.url);
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      await terminal.question(
        "  Confirm the browser shows 'first revision', then press Enter. ",
      );
      const replacedDoc = await parseResponse(
        await apiFetch(apiPath(createdDoc.url), {
          method: "PUT",
          headers: {
            ...uploadHeaders,
            "Content-Disposition": 'inline; filename="acceptance.html"',
            "If-Match": createdDoc.etag,
          },
          body: secondDoc,
        }),
        200,
        "Doc Re-drop",
        docUploadResponseSchema,
      );
      assert(
        replacedDoc.url === createdDoc.url,
        "Doc Re-drop changed its URL.",
      );
      await terminal.question(
        "  Refresh the open Doc, confirm it shows 'second revision', then press Enter. ",
      );
    } finally {
      terminal.close();
    }
    const refreshedDoc = await fetch(createdDoc.url, { cache: "no-store" });
    assert(
      (await refreshedDoc.text()).includes("second revision"),
      "Doc refresh did not expose the Re-drop.",
    );

    say("checking Admin inventory, key creation, key revocation, and deletion");
    const inventory = await parseResponse(
      await apiFetch("/api/files", { headers: adminHeaders }),
      200,
      "Admin File inventory",
      dropInventoryPageSchema,
    );
    assert(
      inventory.drops.some(({ url }) => url === createdFile.url),
      "Admin inventory omitted the acceptance File.",
    );
    const disposableKey = await parseResponse(
      await apiFetch("/api/admin/keys", { method: "POST", headers: adminHeaders }),
      201,
      "Admin Upload Key creation",
      createdUploadKeySchema,
    );
    disposableCredentialId = disposableKey.credentialId;
    const listedKeys = await parseResponse(
      await apiFetch("/api/admin/keys", { headers: adminHeaders }),
      200,
      "Admin Upload Key inventory",
      uploadKeyListSchema,
    );
    assert(
      listedKeys.keys.some(({ credentialId }) => credentialId === disposableKey.credentialId),
      "Admin Upload Key inventory omitted the new key.",
    );
    await expectStatus(
      await apiFetch(`/api/admin/keys/${disposableKey.credentialId}`, {
        method: "DELETE",
        headers: adminHeaders,
      }),
      204,
      "Admin Upload Key revocation",
    );
    disposableCredentialId = undefined;

    say("creating a separate File for the live expiry sweep");
    const expiryFile = await parseResponse(
      await apiFetch("/api/files", {
        method: "POST",
        headers: {
          ...uploadHeaders,
          "Content-Disposition": 'inline; filename="expiry.png"',
          "Drop-Retention": "7d",
        },
        body: png,
      }),
      201,
      "expiry File creation",
      fileUploadResponseSchema,
    );
    createdDrops.push(expiryFile.url);
    const expiryKey = new URL(expiryFile.url).pathname.slice(1);
    const r2Url = `${r2Origin}/drop-content/${expiryKey}`;
    const r2Head = await expectStatus(
      await r2.fetch(r2Url, { method: "HEAD" }),
      200,
      "R2 expiry object HEAD",
    );
    const r2Etag = r2Head.headers.get("etag");
    assert(r2Etag !== null, "R2 expiry object omitted ETag.");
    await expectStatus(
      await r2.fetch(r2Url, {
        method: "PUT",
        headers: {
          "cf-copy-destination-if-match": r2Etag,
          "x-amz-copy-source": `/drop-content/${expiryKey}`,
          "x-amz-copy-source-if-match": r2Etag,
          "x-amz-meta-expiresat": new Date(Date.now() - 60_000).toISOString(),
          "x-amz-metadata-directive": "MERGE",
        },
      }),
      200,
      "R2 expiry timestamp update",
    );

    say("temporarily deploying a once-per-minute sweep; the daily schedule will be restored");
    await deploySchedule("* * * * *");
    minuteScheduleDeployed = true;
    const deadline = Date.now() + 150_000;
    let expired = false;
    while (Date.now() < deadline) {
      const response = await fetch(expiryFile.url, { cache: "no-store" });
      if (response.status === 404) {
        expired = true;
        break;
      }
      say("waiting for the next scheduled sweep");
      await Bun.sleep(10_000);
    }
    assert(expired, "The shortened expiry timestamp survived the scheduled sweep.");
    const expiryIndex = createdDrops.indexOf(expiryFile.url);
    assert(expiryIndex >= 0, "Expiry File was not registered for cleanup.");
    createdDrops.splice(expiryIndex, 1);

    say("all live acceptance checks passed");
  } finally {
    const cleanupErrors: string[] = [];
    if (minuteScheduleDeployed) {
      say("restoring the daily production schedule");
      await deploySchedule("0 0 * * *").catch((error: unknown) => {
        cleanupErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      });
    }
    if (disposableCredentialId !== undefined) {
      const response = await apiFetch(
        `/api/admin/keys/${disposableCredentialId}`,
        {
          method: "DELETE",
          headers: adminHeaders,
        },
      ).catch(() => undefined);
      if (response === undefined) {
        cleanupErrors.push(
          `cleanup request failed for Upload Key ${disposableCredentialId}`,
        );
      } else if (response.status !== 204) {
        cleanupErrors.push(
          `cleanup failed for Upload Key ${disposableCredentialId}: HTTP ${response.status}`,
        );
      }
    }
    for (const dropUrl of createdDrops.reverse()) {
      const response = await apiFetch(apiPath(dropUrl), {
        method: "DELETE",
        headers: adminHeaders,
      }).catch(() => undefined);
      if (response === undefined) {
        cleanupErrors.push(`cleanup request failed for ${dropUrl}`);
      } else if (response.status !== 204 && response.status !== 404) {
        cleanupErrors.push(`cleanup failed for ${dropUrl}: HTTP ${response.status}`);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(cleanupErrors.join("; "));
    }
  }
}

await main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
