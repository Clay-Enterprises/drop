import { Hono } from "hono";

import dropWorker, { type WorkerBindings } from "../src/worker/index.ts";
import { authenticateUploadKey } from "../src/worker/upload-keys.ts";

const app = new Hono<{ Bindings: WorkerBindings }>();

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

app.route("/", dropWorker);

export default app;
