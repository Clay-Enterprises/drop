import { z } from "zod";

import { opaqueIdSchema, retentionSchema } from "./drops.ts";

export const docKindSchema = z.literal("doc");
export type DocKind = z.infer<typeof docKindSchema>;

export const docContentTypeSchema = z.literal("text/html; charset=utf-8");
export type DocContentType = z.infer<typeof docContentTypeSchema>;

export const docUploadResponseSchema = z
  .object({
    url: z.url(),
    kind: docKindSchema,
    contentType: docContentTypeSchema,
    size: z.number().int().nonnegative(),
    retention: retentionSchema,
    expiresAt: z.iso.datetime().nullable(),
    etag: z.string().regex(/^"[^"]+"$/),
  })
  .strict();

export type DocUploadResponse = z.infer<typeof docUploadResponseSchema>;

export const docOpaqueIdSchema = opaqueIdSchema;
