import { Hono } from "hono";
import { z } from "zod";

import {
  opaqueIdSchema,
  retentionSchema,
  retentionUpdateRequestSchema,
  type FileContentType,
  type Retention,
} from "../shared/files.ts";
import { credentialIdSchema } from "../shared/upload-keys.ts";
import {
  changeDocRetention,
  createDoc,
  deleteDoc,
  docContentType,
  listDocs,
  maxDocSize,
  replaceDoc,
  serveDoc,
  validateDocHtml,
} from "./docs.ts";
import {
  changeFileRetention,
  createFile,
  deleteFile,
  detectFileContentType,
  listFiles,
  readUploadBody,
  replaceFile,
  serveFile,
} from "./files.ts";
import {
  sweepExpiredDrops,
  type DeletedDrop,
} from "./drop-content.ts";
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

const inventoryQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(1_000),
});

const invalidCredential = {
  error: {
    code: "invalid_credential",
    message: "The provided credential is invalid.",
  },
} as const;

// This code is part of the stable HTTP contract documented in docs/design.md.
const staleDrop = {
  error: {
    code: "stale_object",
    message: "The Drop changed since this client last observed it.",
  },
} as const;

function logDropDeletion(
  deleted: DeletedDrop,
  kind: "doc" | "file",
  opaqueId: string,
  publicOrigin: string,
): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      credentialId: deleted.owner,
      url: new URL(`/${kind}s/${opaqueId}`, publicOrigin).href,
      kind,
      size: deleted.size,
      retention: deleted.retention,
      outcome: "deleted",
      status: 204,
    }),
  );
}

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

type FileUploadInput = {
  readonly body: Blob;
  readonly contentType: FileContentType;
  readonly originalFilename: string;
};

type FileUploadInputResult =
  | { readonly status: "error"; readonly response: Response }
  | { readonly status: "ok"; readonly input: FileUploadInput };

function jsonError(
  code: string,
  message: string,
  status: number,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

type RetentionInputResult =
  | { readonly status: "error"; readonly response: Response }
  | { readonly status: "ok"; readonly retention: Retention | undefined };

function readRetentionHeader(request: Request): RetentionInputResult {
  const submitted = request.headers.get("Drop-Retention");
  if (submitted === null) {
    return { status: "ok", retention: undefined };
  }

  const retention = retentionSchema.safeParse(submitted);
  return retention.success
    ? { status: "ok", retention: retention.data }
    : {
        status: "error",
        response: jsonError(
          "invalid_request",
          "Drop-Retention must be 7d, 30d, 90d, or keep.",
          400,
        ),
      };
}

async function readFileUploadRequest(
  request: Request,
): Promise<FileUploadInputResult> {
  const originalFilename = parseOriginalFilename(
    request.headers.get("Content-Disposition") ?? undefined,
  );
  if (originalFilename === undefined) {
    return {
      status: "error",
      response: jsonError(
        "invalid_request",
        "Content-Disposition must contain an original filename.",
        400,
      ),
    };
  }

  const upload = await readUploadBody(request);
  if (upload.status === "too_large") {
    return {
      status: "error",
      response: jsonError(
        "payload_too_large",
        "Files must not exceed 95 MiB.",
        413,
      ),
    };
  }

  const contentType = await detectFileContentType(upload.body);
  return contentType === undefined
    ? {
        status: "error",
        response: jsonError(
          "unsupported_media",
          "The submitted bytes are not a supported File type.",
          415,
        ),
      }
    : {
        status: "ok",
        input: { body: upload.body, contentType, originalFilename },
      };
}

async function readDocUploadRequest(
  request: Request,
): Promise<
  | { readonly status: "error"; readonly response: Response }
  | {
      readonly status: "ok";
      readonly input: { readonly body: Blob; readonly originalFilename: string };
    }
> {
  const originalFilename = parseOriginalFilename(
    request.headers.get("Content-Disposition") ?? undefined,
  );
  if (originalFilename === undefined) {
    return {
      status: "error",
      response: jsonError(
        "invalid_request",
        "Content-Disposition must contain an original filename.",
        400,
      ),
    };
  }

  const upload = await readUploadBody(request, maxDocSize);
  if (upload.status === "too_large") {
    return {
      status: "error",
      response: jsonError(
        "payload_too_large",
        "Docs must not exceed 512 KiB.",
        413,
      ),
    };
  }
  const bytes = new Uint8Array(await upload.body.arrayBuffer());
  let html: string;
  try {
    html = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    return {
      status: "error",
      response: jsonError(
        "invalid_doc",
        "The submitted Doc violates the HTML communication contract.",
        422,
      ),
    };
  }
  if (!(await validateDocHtml(html))) {
    return {
      status: "error",
      response: jsonError(
        "invalid_doc",
        "The submitted Doc violates the HTML communication contract.",
        422,
      ),
    };
  }
  return {
    status: "ok",
    input: { body: new Blob([bytes], { type: docContentType }), originalFilename },
  };
}

function bearerCredential(authorization: string | undefined): string {
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

export const app = new Hono<{ Bindings: WorkerBindings }>();

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

app.get("/api/files", async (context) => {
  const { ADMIN_KEY: adminKey } = environmentSchema.parse(context.env);
  if (context.req.header("Authorization") !== `Bearer ${adminKey}`) {
    return context.json(invalidCredential, 401);
  }
  const query = inventoryQuerySchema.safeParse({
    cursor: context.req.query("cursor"),
    limit: context.req.query("limit"),
  });
  if (!query.success) {
    return context.json(
      {
        error: {
          code: "invalid_request",
          message: "The inventory cursor or limit is invalid.",
        },
      },
      400,
    );
  }
  return context.json(
    await listFiles(context.env.CONTENT_STORE, {
      cursor: query.data.cursor,
      limit: query.data.limit,
      publicOrigin: new URL(context.req.url).origin,
    }),
  );
});

app.get("/api/docs", async (context) => {
  const { ADMIN_KEY: adminKey } = environmentSchema.parse(context.env);
  if (context.req.header("Authorization") !== `Bearer ${adminKey}`) {
    return context.json(invalidCredential, 401);
  }
  const query = inventoryQuerySchema.safeParse({
    cursor: context.req.query("cursor"),
    limit: context.req.query("limit"),
  });
  if (!query.success) {
    return context.json(
      {
        error: {
          code: "invalid_request",
          message: "The inventory cursor or limit is invalid.",
        },
      },
      400,
    );
  }
  return context.json(
    await listDocs(context.env.CONTENT_STORE, {
      cursor: query.data.cursor,
      limit: query.data.limit,
      publicOrigin: new URL(context.req.url).origin,
    }),
  );
});

app.delete("/api/files/:opaqueId", async (context) => {
  const { ADMIN_KEY: adminKey } = environmentSchema.parse(context.env);
  if (context.req.header("Authorization") !== `Bearer ${adminKey}`) {
    return context.json(invalidCredential, 401);
  }
  const opaqueId = opaqueIdSchema.safeParse(context.req.param("opaqueId"));
  if (!opaqueId.success) {
    return context.json(
      { error: { code: "not_found", message: "The File does not exist." } },
      404,
    );
  }
  const deleted = await deleteFile(context.env.CONTENT_STORE, opaqueId.data);
  if (deleted === undefined) {
    return context.json(
      { error: { code: "not_found", message: "The File does not exist." } },
      404,
    );
  }
  logDropDeletion(
    deleted,
    "file",
    opaqueId.data,
    new URL(context.req.url).origin,
  );
  return context.body(null, 204);
});

app.delete("/api/docs/:opaqueId", async (context) => {
  const { ADMIN_KEY: adminKey } = environmentSchema.parse(context.env);
  if (context.req.header("Authorization") !== `Bearer ${adminKey}`) {
    return context.json(invalidCredential, 401);
  }
  const opaqueId = opaqueIdSchema.safeParse(context.req.param("opaqueId"));
  if (!opaqueId.success) {
    return context.json(
      { error: { code: "not_found", message: "The Doc does not exist." } },
      404,
    );
  }
  const deleted = await deleteDoc(context.env.CONTENT_STORE, opaqueId.data);
  if (deleted === undefined) {
    return context.json(
      { error: { code: "not_found", message: "The Doc does not exist." } },
      404,
    );
  }
  logDropDeletion(
    deleted,
    "doc",
    opaqueId.data,
    new URL(context.req.url).origin,
  );
  return context.body(null, 204);
});

app.post("/api/files", async (context) => {
  const credentialId = await authenticateUploadKey(
    context.env.CONTROL_STORE,
    bearerCredential(context.req.header("Authorization")),
  );
  if (credentialId === undefined) {
    return context.json(invalidCredential, 401);
  }

  const retention = readRetentionHeader(context.req.raw);
  if (retention.status === "error") {
    return retention.response;
  }

  const upload = await readFileUploadRequest(context.req.raw);
  if (upload.status === "error") {
    return upload.response;
  }

  const created = await createFile(
    context.env.CONTENT_STORE,
    {
      body: upload.input.body,
      contentType: upload.input.contentType,
      credentialId,
      originalFilename: upload.input.originalFilename,
      publicOrigin: new URL(context.req.url).origin,
      retention: retention.retention ?? "keep",
    },
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

app.post("/api/docs", async (context) => {
  const credentialId = await authenticateUploadKey(
    context.env.CONTROL_STORE,
    bearerCredential(context.req.header("Authorization")),
  );
  if (credentialId === undefined) {
    return context.json(invalidCredential, 401);
  }

  const retention = readRetentionHeader(context.req.raw);
  if (retention.status === "error") {
    return retention.response;
  }
  const upload = await readDocUploadRequest(context.req.raw);
  if (upload.status === "error") {
    return upload.response;
  }

  const created = await createDoc(context.env.CONTENT_STORE, {
    body: upload.input.body,
    credentialId,
    originalFilename: upload.input.originalFilename,
    publicOrigin: new URL(context.req.url).origin,
    retention: retention.retention ?? "keep",
  });
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

app.put("/api/docs/:opaqueId", async (context) => {
  const credentialId = await authenticateUploadKey(
    context.env.CONTROL_STORE,
    bearerCredential(context.req.header("Authorization")),
  );
  if (credentialId === undefined) {
    return context.json(invalidCredential, 401);
  }
  const opaqueId = opaqueIdSchema.safeParse(context.req.param("opaqueId"));
  if (!opaqueId.success) {
    return context.json(
      { error: { code: "not_found", message: "The Doc does not exist." } },
      404,
    );
  }
  const observedEtag = context.req.header("If-Match");
  if (observedEtag === undefined) {
    return context.json(
      {
        error: {
          code: "invalid_request",
          message: "If-Match is required to Re-drop a Doc.",
        },
      },
      400,
    );
  }
  const retention = readRetentionHeader(context.req.raw);
  if (retention.status === "error") {
    return retention.response;
  }
  const upload = await readDocUploadRequest(context.req.raw);
  if (upload.status === "error") {
    return upload.response;
  }
  const result = await replaceDoc(context.env.CONTENT_STORE, {
    body: upload.input.body,
    credentialId,
    observedEtag,
    opaqueId: opaqueId.data,
    originalFilename: upload.input.originalFilename,
    publicOrigin: new URL(context.req.url).origin,
    retention: retention.retention,
  });
  if (result.status === "missing") {
    return context.json(
      { error: { code: "not_found", message: "The Doc does not exist." } },
      404,
    );
  }
  if (result.status === "forbidden") {
    return context.json(
      {
        error: {
          code: "wrong_owner",
          message: "This Upload Key did not create the Doc.",
        },
      },
      403,
    );
  }
  if (result.status === "stale") {
    return context.json(staleDrop, 409);
  }
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      credentialId,
      url: result.response.url,
      kind: result.response.kind,
      size: result.response.size,
      retention: result.response.retention,
      outcome: "replaced",
      status: 200,
    }),
  );
  return context.json(result.response);
});

app.patch("/api/docs/:opaqueId", async (context) => {
  const credentialId = await authenticateUploadKey(
    context.env.CONTROL_STORE,
    bearerCredential(context.req.header("Authorization")),
  );
  if (credentialId === undefined) {
    return context.json(invalidCredential, 401);
  }
  const opaqueId = opaqueIdSchema.safeParse(context.req.param("opaqueId"));
  if (!opaqueId.success) {
    return context.json(
      { error: { code: "not_found", message: "The Doc does not exist." } },
      404,
    );
  }
  const observedEtag = context.req.header("If-Match");
  if (observedEtag === undefined) {
    return context.json(
      {
        error: {
          code: "invalid_request",
          message: "If-Match is required to change Doc retention.",
        },
      },
      400,
    );
  }
  const input = retentionUpdateRequestSchema.safeParse(
    await context.req.json().catch(() => undefined),
  );
  if (!input.success) {
    return context.json(
      {
        error: {
          code: "invalid_request",
          message: "The request must contain a valid Retention Class.",
        },
      },
      400,
    );
  }
  const result = await changeDocRetention(context.env.CONTENT_STORE, {
    credentialId,
    observedEtag,
    opaqueId: opaqueId.data,
    publicOrigin: new URL(context.req.url).origin,
    retention: input.data.retention,
  });
  if (result.status === "missing") {
    return context.json(
      { error: { code: "not_found", message: "The Doc does not exist." } },
      404,
    );
  }
  if (result.status === "forbidden") {
    return context.json(
      {
        error: {
          code: "wrong_owner",
          message: "This Upload Key did not create the Doc.",
        },
      },
      403,
    );
  }
  if (result.status === "stale") {
    return context.json(staleDrop, 409);
  }
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      credentialId,
      url: result.response.url,
      kind: result.response.kind,
      size: result.response.size,
      retention: result.response.retention,
      outcome: "retention_changed",
      status: 200,
    }),
  );
  return context.json(result.response);
});

app.put("/api/files/:opaqueId", async (context) => {
  const credentialId = await authenticateUploadKey(
    context.env.CONTROL_STORE,
    bearerCredential(context.req.header("Authorization")),
  );
  if (credentialId === undefined) {
    return context.json(invalidCredential, 401);
  }

  const opaqueId = opaqueIdSchema.safeParse(context.req.param("opaqueId"));
  if (!opaqueId.success) {
    return context.json(
      {
        error: {
          code: "not_found",
          message: "The File does not exist.",
        },
      },
      404,
    );
  }

  const observedEtag = context.req.header("If-Match");
  if (observedEtag === undefined) {
    return context.json(
      {
        error: {
          code: "invalid_request",
          message: "If-Match is required to Re-drop a File.",
        },
      },
      400,
    );
  }

  const retention = readRetentionHeader(context.req.raw);
  if (retention.status === "error") {
    return retention.response;
  }

  const upload = await readFileUploadRequest(context.req.raw);
  if (upload.status === "error") {
    return upload.response;
  }

  const result = await replaceFile(
    context.env.CONTENT_STORE,
    {
      body: upload.input.body,
      contentType: upload.input.contentType,
      credentialId,
      observedEtag,
      opaqueId: opaqueId.data,
      originalFilename: upload.input.originalFilename,
      publicOrigin: new URL(context.req.url).origin,
      retention: retention.retention,
    },
  );
  if (result.status === "missing") {
    return context.json(
      { error: { code: "not_found", message: "The File does not exist." } },
      404,
    );
  }
  if (result.status === "forbidden") {
    return context.json(
      {
        error: {
          code: "wrong_owner",
          message: "This Upload Key did not create the File.",
        },
      },
      403,
    );
  }
  if (result.status === "stale") {
    return context.json(staleDrop, 409);
  }

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      credentialId,
      url: result.response.url,
      kind: result.response.kind,
      size: result.response.size,
      retention: result.response.retention,
      outcome: "replaced",
      status: 200,
    }),
  );
  return context.json(result.response);
});

app.patch("/api/files/:opaqueId", async (context) => {
  const credentialId = await authenticateUploadKey(
    context.env.CONTROL_STORE,
    bearerCredential(context.req.header("Authorization")),
  );
  if (credentialId === undefined) {
    return context.json(invalidCredential, 401);
  }

  const opaqueId = opaqueIdSchema.safeParse(context.req.param("opaqueId"));
  if (!opaqueId.success) {
    return context.json(
      { error: { code: "not_found", message: "The File does not exist." } },
      404,
    );
  }

  const observedEtag = context.req.header("If-Match");
  if (observedEtag === undefined) {
    return context.json(
      {
        error: {
          code: "invalid_request",
          message: "If-Match is required to change File retention.",
        },
      },
      400,
    );
  }

  const input = retentionUpdateRequestSchema.safeParse(
    await context.req.json().catch(() => undefined),
  );
  if (!input.success) {
    return context.json(
      {
        error: {
          code: "invalid_request",
          message: "The request must contain a valid Retention Class.",
        },
      },
      400,
    );
  }

  const result = await changeFileRetention(
    context.env.CONTENT_STORE,
    {
      credentialId,
      observedEtag,
      opaqueId: opaqueId.data,
      publicOrigin: new URL(context.req.url).origin,
      retention: input.data.retention,
    },
  );
  if (result.status === "missing") {
    return context.json(
      { error: { code: "not_found", message: "The File does not exist." } },
      404,
    );
  }
  if (result.status === "forbidden") {
    return context.json(
      {
        error: {
          code: "wrong_owner",
          message: "This Upload Key did not create the File.",
        },
      },
      403,
    );
  }
  if (result.status === "stale") {
    return context.json(staleDrop, 409);
  }

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      credentialId,
      url: result.response.url,
      kind: result.response.kind,
      size: result.response.size,
      retention: result.response.retention,
      outcome: "retention_changed",
      status: 200,
    }),
  );
  return context.json(result.response);
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

app.on(["GET", "HEAD"], "/docs/:opaqueId", async (context) => {
  const opaqueId = opaqueIdSchema.safeParse(context.req.param("opaqueId"));
  if (!opaqueId.success) {
    return context.body(null, 404);
  }
  return serveDoc(
    context.env.CONTENT_STORE,
    opaqueId.data,
    context.req.method as "GET" | "HEAD",
    context.req.raw.headers,
  );
});

const worker: ExportedHandler<WorkerBindings> = {
  fetch(request, environment, executionContext) {
    return app.fetch(request, environment, executionContext);
  },
  async scheduled(controller, environment) {
    await sweepExpiredDrops(
      environment.CONTENT_STORE,
      controller.scheduledTime,
    );
  },
};

export default worker;
