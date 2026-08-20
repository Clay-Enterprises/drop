import { z } from "zod";

export const fileKindSchema = z.literal("file");
export type FileKind = z.infer<typeof fileKindSchema>;

export const fileContentTypeSchema = z.enum([
  "image/png",
  "image/gif",
]);
export type FileContentType = z.infer<typeof fileContentTypeSchema>;

export const retentionSchema = z.enum(["7d", "30d", "90d", "keep"]);
export type Retention = z.infer<typeof retentionSchema>;

export const retentionUpdateRequestSchema = z
  .object({ retention: retentionSchema })
  .strict();

export const opaqueIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32}$/)
  .brand<"OpaqueId">();
export type OpaqueId = z.infer<typeof opaqueIdSchema>;

export const fileUploadResponseSchema = z
  .object({
    url: z.url(),
    kind: fileKindSchema,
    contentType: fileContentTypeSchema,
    size: z.number().int().nonnegative(),
    retention: retentionSchema,
    expiresAt: z.iso.datetime().nullable(),
    etag: z.string().regex(/^"[^"]+"$/),
  })
  .strict();

export type FileUploadResponse = z.infer<typeof fileUploadResponseSchema>;

export const localBindingContentSchema = z
  .object({
    path: z.string(),
    url: z.url(),
    kind: fileKindSchema,
    etag: z.string().regex(/^"[^"]+"$/),
    retention: retentionSchema,
  })
  .strict();

export type LocalBindingContent = z.infer<typeof localBindingContentSchema>;

const checksummedLocalBindingSchema = localBindingContentSchema
  .extend({
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    formatVersion: z.literal(1),
  })
  .strict();

export const localBindingSchema = z.union([
  checksummedLocalBindingSchema,
  localBindingContentSchema,
]);

export type LocalBinding = z.infer<typeof localBindingSchema>;
