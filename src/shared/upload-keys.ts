import { z } from "zod";

export const credentialIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .brand<"CredentialId">();
export type CredentialId = z.infer<typeof credentialIdSchema>;
export const uploadKeySchema = z.string().regex(
  /^drop_u_[0-9a-f]{32}_[0-9a-f]{64}$/,
);

export const uploadKeyRecordSchema = z
  .object({
    createdAt: z.iso.datetime(),
    secretHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type UploadKeyRecord = z.infer<typeof uploadKeyRecordSchema>;

export const createdUploadKeySchema = z
  .object({
    credentialId: credentialIdSchema,
    createdAt: z.iso.datetime(),
    key: uploadKeySchema,
  })
  .strict();

export type CreatedUploadKey = z.infer<typeof createdUploadKeySchema>;

export const uploadKeySummarySchema = z
  .object({
    credentialId: credentialIdSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export type UploadKeySummary = z.infer<typeof uploadKeySummarySchema>;

export const uploadKeyListSchema = z
  .object({
    keys: z.array(uploadKeySummarySchema),
  })
  .strict();
