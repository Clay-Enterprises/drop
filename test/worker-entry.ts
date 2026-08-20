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

app.route("/", dropWorker);

export default app;
