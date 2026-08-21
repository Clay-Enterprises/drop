import { Hono } from "hono";

import { app as dropApp, type WorkerBindings } from "../src/worker/index.ts";
import {
  sweepExpiredDrops,
  writeExpiryTombstone,
} from "../src/worker/drop-content.ts";
import { authenticateUploadKey } from "../src/worker/upload-keys.ts";

const app = new Hono<{ Bindings: WorkerBindings }>();

type ExpiryRacePausePoint = "after-tombstone" | "before-tombstone";

interface ExpiryRacePause {
  candidate: R2Object | undefined;
  hasReached: boolean;
  readonly key: string;
  readonly pause: ExpiryRacePausePoint;
}

let expiryRacePause: ExpiryRacePause | undefined;

function createExpiryRacePause(
  key: string,
  pause: ExpiryRacePausePoint,
): ExpiryRacePause {
  return { candidate: undefined, hasReached: false, key, pause };
}

async function pauseExpiryRace(
  pause: ExpiryRacePausePoint,
  candidate: R2Object,
): Promise<boolean | undefined> {
  const configured = expiryRacePause;
  if (configured?.key !== candidate.key || configured.pause !== pause) {
    return;
  }
  configured.candidate = candidate;
  configured.hasReached = true;
  return false;
}

app.get("/__test/authenticate-upload-key", async (context) => {
  const authorization = context.req.header("Authorization");
  const key = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const credentialId = await authenticateUploadKey(
    context.env.CONTROL_STORE,
    key,
  );

  if (credentialId === undefined) {
    return context.json(
      {
        error: {
          code: "invalid_credential",
          message: "The provided credential is invalid.",
        },
      },
      401,
    );
  }

  return context.json({ credentialId });
});

app.get("/__test/content-objects", async (context) => {
  const page = await context.env.CONTENT_STORE.list({
    prefix: "files/",
    include: ["httpMetadata", "customMetadata"],
  });
  return context.json({
    objects: page.objects.map((object) => ({
      key: object.key,
      size: object.size,
      etag: object.httpEtag,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    })),
  });
});

app.delete("/__test/content-objects/:opaqueId", async (context) => {
  await context.env.CONTENT_STORE.delete(
    `files/${context.req.param("opaqueId")}`,
  );
  return context.body(null, 204);
});

app.patch("/__test/content-objects/:opaqueId/expiry", async (context) => {
  const key = `files/${context.req.param("opaqueId")}`;
  const current = await context.env.CONTENT_STORE.get(key);
  if (current === null) {
    return context.body(null, 404);
  }
  const input = (await context.req.json()) as { expiresAt: string };
  await context.env.CONTENT_STORE.put(key, current.body, {
    httpMetadata: current.httpMetadata,
    customMetadata: {
      ...current.customMetadata,
      expiresat: input.expiresAt,
    },
  });
  return context.body(null, 204);
});

app.patch("/__test/doc-objects/:opaqueId/expiry", async (context) => {
  const key = `docs/${context.req.param("opaqueId")}`;
  const current = await context.env.CONTENT_STORE.get(key);
  if (current === null) {
    return context.body(null, 404);
  }
  const input = (await context.req.json()) as { expiresAt: string };
  await context.env.CONTENT_STORE.put(key, current.body, {
    httpMetadata: current.httpMetadata,
    customMetadata: {
      ...current.customMetadata,
      expiresat: input.expiresAt,
    },
  });
  return context.body(null, 204);
});

app.post("/__test/expiry-race", async (context) => {
  const input = (await context.req.json()) as {
    opaqueId: string;
    pause: ExpiryRacePausePoint;
  };
  expiryRacePause = createExpiryRacePause(
    `files/${input.opaqueId}`,
    input.pause,
  );
  return context.body(null, 204);
});

app.get("/__test/expiry-race/wait", async (context) => {
  if (expiryRacePause === undefined) {
    return context.body(null, 409);
  }
  return context.body(null, expiryRacePause.hasReached ? 204 : 202);
});

app.post("/__test/expiry-race/release", async (context) => {
  const configured = expiryRacePause;
  if (configured?.candidate === undefined) {
    return context.body(null, 409);
  }
  if (configured.pause === "before-tombstone") {
    if (
      await writeExpiryTombstone(
        context.env.CONTENT_STORE,
        configured.candidate,
      )
    ) {
      await context.env.CONTENT_STORE.delete(configured.candidate.key);
    }
  } else {
    await context.env.CONTENT_STORE.delete(configured.candidate.key);
  }
  expiryRacePause = undefined;
  return context.body(null, 204);
});

app.route("/", dropApp);

const worker: ExportedHandler<WorkerBindings> = {
  fetch(request, environment, executionContext) {
    return app.fetch(request, environment, executionContext);
  },
  async scheduled(controller, environment) {
    await sweepExpiredDrops(
      environment.CONTENT_STORE,
      controller.scheduledTime,
      {
        afterTombstone: (candidate) =>
          pauseExpiryRace("after-tombstone", candidate),
        beforeTombstone: (candidate) =>
          pauseExpiryRace("before-tombstone", candidate),
        pageSize: 2,
      },
    );
  },
};

export default worker;
