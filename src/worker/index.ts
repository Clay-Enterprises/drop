import { Hono } from "hono";
import { z } from "zod";

import { opaqueIdSchema } from "../shared/files.ts";
import { credentialIdSchema } from "../shared/upload-keys.ts";
import { createFile, isPng, readUploadBody, serveFile } from "./files.ts";
import {
  authenticateUploadKey,
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

function parseOriginalFilename(
  contentDisposition: string | undefined,
): string | undefined {
  if (contentDisposition === undefined || contentDisposition.length > 2_048) {
    return undefined;
  }

  const extended = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(
    contentDisposition,
  );
  if (extended?.[1] !== undefined) {
    try {
      const filename = decodeURIComponent(extended[1].trim());
      return filename !== "" && !filename.includes("\0")
        ? filename
        : undefined;
    } catch {
      return undefined;
    }
  }

  const quoted = /(?:^|;)\s*filename="((?:\\.|[^"])*)"/i.exec(
    contentDisposition,
  );
  if (quoted?.[1] !== undefined) {
    const filename = quoted[1].replace(/\\([\\"])/g, "$1");
    return filename !== "" && !filename.includes("\0")
      ? filename
      : undefined;
  }

  const unquoted = /(?:^|;)\s*filename=([^;\s]+)/i.exec(contentDisposition);
  return unquoted?.[1] !== undefined && !unquoted[1].includes("\0")
    ? unquoted[1]
    : undefined;
}

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

app.post("/api/files", async (context) => {
  const authorization = context.req.header("Authorization");
  const uploadKey = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const credentialId = await authenticateUploadKey(
    context.env.CONTROL_STORE,
    uploadKey,
  );
  if (credentialId === undefined) {
    return context.json(invalidCredential, 401);
  }

  const originalFilename = parseOriginalFilename(
    context.req.header("Content-Disposition"),
  );
  if (originalFilename === undefined) {
    return context.json(
      {
        error: {
          code: "invalid_request",
          message: "Content-Disposition must contain an original filename.",
        },
      },
      400,
    );
  }

  const upload = await readUploadBody(context.req.raw);
  if (upload.status === "too_large") {
    return context.json(
      {
        error: {
          code: "payload_too_large",
          message: "Files must not exceed 95 MiB.",
        },
      },
      413,
    );
  }

  if (!(await isPng(upload.body))) {
    return context.json(
      {
        error: {
          code: "unsupported_media",
          message: "The submitted bytes are not a supported File type.",
        },
      },
      415,
    );
  }

  const created = await createFile(
    context.env.CONTENT_STORE,
    upload.body,
    credentialId,
    originalFilename,
    new URL(context.req.url).origin,
  );
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      credentialId,
      url: created.url,
      kind: created.kind,
      size: created.size,
      retention: created.retention,
      outcome: "created",
      status: 201,
    }),
  );

  context.header("Location", created.url);
  return context.json(created, 201);
});

app.on(["GET", "HEAD"], "/files/:opaqueId", async (context) => {
  const opaqueId = opaqueIdSchema.safeParse(context.req.param("opaqueId"));
  if (!opaqueId.success) {
    return context.body(null, 404);
  }

  return serveFile(
    context.env.CONTENT_STORE,
    opaqueId.data,
    context.req.method as "GET" | "HEAD",
    context.req.raw.headers,
  );
});

export default app;
