import { Hono } from "hono";
import { z } from "zod";

import { credentialIdSchema } from "../shared/upload-keys.ts";
import {
  createUploadKey,
  listUploadKeys,
  revokeUploadKey,
} from "./upload-keys.ts";

export interface WorkerBindings {
  ADMIN_KEY: string;
  CONTENT_STORE: R2Bucket;
  CONTROL_STORE: R2Bucket;
}

const environmentSchema = z.object({
  ADMIN_KEY: z.string().startsWith("drop_a_"),
});

const invalidCredential = {
  error: {
    code: "invalid_credential",
    message: "The provided credential is invalid.",
  },
} as const;

const app = new Hono<{ Bindings: WorkerBindings }>();

app.use("/api/admin/*", async (context, next) => {
  const { ADMIN_KEY: adminKey } = environmentSchema.parse(context.env);
  const authorization = context.req.header("Authorization");

  if (authorization !== `Bearer ${adminKey}`) {
    return context.json(invalidCredential, 401);
  }

  await next();
});

app.post("/api/admin/keys", async (context) => {
  const createdUploadKey = await createUploadKey(context.env.CONTROL_STORE);
  return context.json(createdUploadKey, 201);
});

app.get("/api/admin/keys", async (context) => {
  const keys = await listUploadKeys(context.env.CONTROL_STORE);
  return context.json({ keys });
});

app.delete("/api/admin/keys/:credentialId", async (context) => {
  const credentialId = credentialIdSchema.safeParse(
    context.req.param("credentialId"),
  );
  if (!credentialId.success) {
    return context.json(
      {
        error: {
          code: "invalid_request",
          message: "The credential ID is invalid.",
        },
      },
      400,
    );
  }

  await revokeUploadKey(context.env.CONTROL_STORE, credentialId.data);
  return context.body(null, 204);
});

export default app;
