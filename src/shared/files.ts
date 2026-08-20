import { z } from "zod";

export {
  localBindingContentSchema,
  localBindingSchema,
  opaqueIdSchema,
  retentionSchema,
  retentionUpdateRequestSchema,
  type LocalBinding,
  type LocalBindingContent,
  type OpaqueId,
  type Retention,
} from "./drops.ts";
import { retentionSchema } from "./drops.ts";

export const fileKindSchema = z.literal("file");
export type FileKind = z.infer<typeof fileKindSchema>;

export const fileContentTypeSchema = z.enum([
  "image/png",
  "image/gif",
]);
export type FileContentType = z.infer<typeof fileContentTypeSchema>;

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
