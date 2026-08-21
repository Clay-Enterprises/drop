import { z } from "zod";

import { credentialIdSchema } from "./upload-keys.ts";

export const dropKindSchema = z.enum(["file", "doc"]);
export type DropKind = z.infer<typeof dropKindSchema>;

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

export const dropInventoryEntrySchema = z
  .object({
    url: z.url(),
    kind: dropKindSchema,
    retention: retentionSchema,
    owner: credentialIdSchema,
    uploadedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    size: z.number().int().nonnegative(),
    contentType: z.string().min(1),
    originalFilename: z.string(),
  })
  .strict();

export type DropInventoryEntry = z.infer<typeof dropInventoryEntrySchema>;

export const dropInventoryPageSchema = z
  .object({
    drops: z.array(dropInventoryEntrySchema),
    cursor: z.string().nullable(),
  })
  .strict();

export type DropInventoryPage = z.infer<typeof dropInventoryPageSchema>;

export const localBindingContentSchema = z
  .object({
    path: z.string(),
    url: z.url(),
    kind: dropKindSchema,
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
