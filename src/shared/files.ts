import { z } from "zod";

export const fileKindSchema = z.literal("file");
export type FileKind = z.infer<typeof fileKindSchema>;

export const retentionSchema = z.enum(["7d", "30d", "90d", "keep"]);
export type Retention = z.infer<typeof retentionSchema>;

export const opaqueIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32}$/)
  .brand<"OpaqueId">();
export type OpaqueId = z.infer<typeof opaqueIdSchema>;

export const fileUploadResponseSchema = z
  .object({
    url: z.url(),
    kind: fileKindSchema,
    contentType: z.literal("image/png"),
    size: z.number().int().nonnegative(),
    retention: retentionSchema,
    expiresAt: z.iso.datetime().nullable(),
    etag: z.string().regex(/^"[^"]+"$/),
  })
  .strict();

export type FileUploadResponse = z.infer<typeof fileUploadResponseSchema>;

export const localBindingSchema = z
  .object({
    path: z.string(),
    url: z.url(),
    kind: fileKindSchema,
    etag: z.string(),
    retention: retentionSchema,
  })
  .strict();

export type LocalBinding = z.infer<typeof localBindingSchema>;
