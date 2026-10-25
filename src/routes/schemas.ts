import { z } from 'zod';
import { SHA256_PATTERN } from '../utils/hash.js';
import { DEVICE_ID_PATTERN, FILE_ID_PATTERN } from '../utils/ids.js';

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email()
  .transform((value) => value.toLowerCase());
const passwordSchema = z.string().min(10).max(512);
const keyEnvelopeSchema = z.string().min(1).max(65_536);

export const deviceInputSchema = z
  .strictObject({
    id: z.string().regex(DEVICE_ID_PATTERN).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    platform: z.string().trim().max(60).optional(),
  })
  .optional();

export const setupSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120).optional(),
  setupToken: z.string().min(1).max(512).optional(),
  device: deviceInputSchema,
});

export const registerSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120).optional(),
  device: deviceInputSchema,
});

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(512),
  device: deviceInputSchema,
});

export const refreshSchema = z.strictObject({
  refreshToken: z.string().min(20).max(512),
});

export const logoutSchema = z.strictObject({
  refreshToken: z.string().min(20).max(512),
});

export const updateMeSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(120).nullable(),
});

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(512),
  newPassword: passwordSchema,
});

export const vaultParams = z.object({
  vaultId: idSchema,
});

export const fileParams = vaultParams.extend({
  fileId: z.string().regex(FILE_ID_PATTERN),
});

export const versionParams = fileParams.extend({
  versionId: idSchema,
});

export const blobParams = vaultParams.extend({
  hash: z.string().regex(SHA256_PATTERN),
});

export const memberParams = vaultParams.extend({
  userId: idSchema,
});

export const deviceParams = z.object({
  deviceId: z.string().regex(DEVICE_ID_PATTERN),
});

export const updateDeviceSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
});

export const createVaultSchema = z.strictObject({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(200),
  e2ee: z.boolean().optional(),
  keyEnvelope: keyEnvelopeSchema.optional(),
});

export const updateVaultSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
});

export const addMemberSchema = z.strictObject({
  email: emailSchema,
  role: z.enum(['editor', 'reader']),
  keyEnvelope: keyEnvelopeSchema.optional(),
});

export const updateMemberSchema = z
  .strictObject({
    role: z.enum(['editor', 'reader']).optional(),
    keyEnvelope: keyEnvelopeSchema.nullable().optional(),
  })
  .refine((value) => value.role !== undefined || value.keyEnvelope !== undefined, {
    message: 'Provide role and/or keyEnvelope',
  });

export const changeSchema = z.strictObject({
  fileId: z.string().regex(FILE_ID_PATTERN),
  path: z.string().min(1).max(16_384),
  kind: z.enum(['file', 'folder']),
  encrypted: z.boolean().optional(),
  hash: z.string().regex(SHA256_PATTERN).nullable().optional(),
  size: z.number().int().nonnegative().optional(),
  mtime: z.number().int().nonnegative().optional(),
  ctime: z.number().int().nonnegative().optional(),
  deleted: z.boolean().optional(),
  expectedRevision: z.number().int().nonnegative().nullable().optional(),
});

export const pushChangesSchema = z.strictObject({
  atomic: z.boolean().optional(),
  changes: z.array(changeSchema).min(1).max(2000),
});

export const restoreVersionSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative().nullable().optional(),
  path: z.string().min(1).max(16_384).optional(),
});

export const updateVaultSettingsSchema = z.strictObject({
  settings: z.record(z.string(), z.unknown()),
  expectedRevision: z.number().int().nonnegative().nullable().optional(),
});

export const changesQuery = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  until: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

export const filesQuery = z.object({
  includeDeleted: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  cursor: z.string().regex(FILE_ID_PATTERN).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

export const versionsQuery = z.object({
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const adminUsersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(200).optional(),
});

export const adminUserParams = z.object({
  userId: idSchema,
});

export const adminUserUpdateSchema = z
  .strictObject({
    isAdmin: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .refine((value) => value.isAdmin !== undefined || value.disabled !== undefined, {
    message: 'Provide isAdmin and/or disabled',
  });

export type ChangeBody = z.infer<typeof changeSchema>;
