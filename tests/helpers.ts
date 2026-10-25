import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { type Config, loadConfig } from '../src/config.js';
import { createUser } from '../src/db/users.js';

export interface Session {
  tokenType: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  deviceId: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    isAdmin: boolean;
  };
}

export interface TestContext {
  app: FastifyInstance;
  config: Config;
  dir: string;
  close: () => Promise<void>;
}

export async function createTestApp(extraEnv: Record<string, string> = {}): Promise<TestContext> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'syncy-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dir,
    JWT_SECRET: 'test-secret-'.repeat(8),
    ALLOW_REGISTRATION: 'false',
    RATE_LIMIT_MAX: '100000',
    LOG_LEVEL: 'silent',
    ...extraEnv,
  });
  const app = await buildApp({ config, logger: false });

  return {
    app,
    config,
    dir,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function setupAdmin(
  app: FastifyInstance,
  options: { email?: string; password?: string; name?: string } = {},
): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/setup',
    payload: {
      email: options.email ?? 'admin@example.com',
      password: options.password ?? 'admin-password-123',
      name: options.name ?? 'Admin',
      device: { name: 'Test device', platform: 'test' },
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(`Setup failed (${response.statusCode}): ${response.body}`);
  }

  return response.json() as Session;
}

export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password, device: { name: 'Second device', platform: 'test' } },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Login failed (${response.statusCode}): ${response.body}`);
  }

  return response.json() as Session;
}

export async function createDbUser(
  app: FastifyInstance,
  email: string,
  password: string,
  isAdmin = false,
): Promise<{ id: string }> {
  return createUser(app.db, {
    email,
    passwordHash: await hashPassword(password),
    displayName: email.split('@')[0] ?? null,
    isAdmin,
  });
}

export async function createVault(
  app: FastifyInstance,
  token: string,
  options: { name?: string; e2ee?: boolean; keyEnvelope?: string } = {},
): Promise<{ id: string; revision: number; e2ee: boolean; name: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/vaults',
    headers: auth(token),
    payload: {
      name: options.name ?? 'Test vault',
      e2ee: options.e2ee ?? false,
      ...(options.keyEnvelope ? { keyEnvelope: options.keyEnvelope } : {}),
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(`Vault creation failed (${response.statusCode}): ${response.body}`);
  }

  return (
    response.json() as { vault: { id: string; revision: number; e2ee: boolean; name: string } }
  ).vault;
}

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function uploadBlob(
  app: FastifyInstance,
  token: string,
  vaultId: string,
  content: Buffer | string,
): Promise<{
  hash: string;
  statusCode: number;
  body: { hash: string; size: number; deduped: boolean };
}> {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const hash = sha256(buffer);
  const response = await app.inject({
    method: 'PUT',
    url: `/v1/vaults/${vaultId}/blobs/${hash}`,
    headers: { ...auth(token), 'content-type': 'application/octet-stream' },
    payload: buffer,
  });

  return {
    hash,
    statusCode: response.statusCode,
    body: response.statusCode < 300 ? response.json() : { hash, size: 0, deduped: false },
  };
}

export interface PushResult {
  statusCode: number;
  body: {
    applied: boolean;
    hasConflicts: boolean;
    revision: number;
    previousRevision: number;
    conflicts: Array<{ fileId: string; code: string; server?: { revision: number } }>;
    results: Array<{ fileId: string; status: string; revision?: number; reason?: string }>;
    error?: { code: string; message: string };
  };
}

export async function pushChanges(
  app: FastifyInstance,
  token: string,
  vaultId: string,
  changes: unknown[],
  atomic?: boolean,
): Promise<PushResult> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/changes`,
    headers: auth(token),
    payload: {
      ...(atomic === undefined ? {} : { atomic }),
      changes,
    },
  });

  return {
    statusCode: response.statusCode,
    body: response.json(),
  };
}

export async function createFile(
  app: FastifyInstance,
  token: string,
  vaultId: string,
  options: {
    fileId: string;
    path: string;
    content: string;
    kind?: 'file' | 'folder';
    expectedRevision?: number | null;
    mtime?: number;
  },
): Promise<{ hash: string | null; push: PushResult }> {
  if (options.kind === 'folder') {
    const push = await pushChanges(app, token, vaultId, [
      {
        fileId: options.fileId,
        path: options.path,
        kind: 'folder',
        expectedRevision: options.expectedRevision ?? null,
      },
    ]);
    return { hash: null, push };
  }

  const uploaded = await uploadBlob(app, token, vaultId, options.content);
  if (uploaded.statusCode >= 300) {
    throw new Error(`Blob upload failed (${uploaded.statusCode})`);
  }

  const push = await pushChanges(app, token, vaultId, [
    {
      fileId: options.fileId,
      path: options.path,
      kind: 'file',
      hash: uploaded.hash,
      size: Buffer.byteLength(options.content),
      mtime: options.mtime ?? Date.now(),
      expectedRevision: options.expectedRevision ?? null,
    },
  ]);

  return { hash: uploaded.hash, push };
}

export async function pullChanges(
  app: FastifyInstance,
  token: string,
  vaultId: string,
  since = 0,
  extra: Record<string, string | number> = {},
): Promise<{
  statusCode: number;
  body: {
    revision: number;
    prunedBeforeRevision: number;
    hasMore: boolean;
    nextCursor: number;
    changes: Array<{
      revision: number;
      fileId: string;
      path: string;
      kind: 'file' | 'folder';
      encrypted: boolean;
      hash: string | null;
      deleted: boolean;
    }>;
    error?: { code: string; message: string };
  };
}> {
  const query = new URLSearchParams({
    since: String(since),
    ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, String(value)])),
  });
  const response = await app.inject({
    method: 'GET',
    url: `/v1/vaults/${vaultId}/changes?${query.toString()}`,
    headers: auth(token),
  });

  return { statusCode: response.statusCode, body: response.json() };
}
