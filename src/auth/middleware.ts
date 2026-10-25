import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { getDevice } from '../db/devices.js';
import type { UserRow } from '../db/users.js';
import { findUserById } from '../db/users.js';
import { forbidden, unauthorized } from '../errors.js';
import { verifyAccessToken } from './jwt.js';

export interface AuthContext {
  user: UserRow;
  deviceId: string | null;
}

function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || Array.isArray(header)) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  const token = readBearerToken(request);
  if (!token) {
    throw unauthorized();
  }

  const config = request.server.config as Config;
  const claims = await verifyAccessToken(config, token);
  const db = request.server.db;
  const user = findUserById(db, claims.userId);

  if (!user) {
    throw unauthorized('USER_NOT_FOUND', 'This account no longer exists');
  }
  if (user.disabled === 1) {
    throw unauthorized('ACCOUNT_DISABLED', 'This account is disabled');
  }
  if (claims.tokenVersion !== user.token_version) {
    throw unauthorized('TOKEN_REVOKED', 'Access token has been revoked');
  }
  if (claims.deviceId && !getDevice(db, user.id, claims.deviceId)) {
    throw unauthorized('DEVICE_REVOKED', 'This device has been removed');
  }

  request.auth = {
    user,
    deviceId: claims.deviceId,
  };
}

export async function requireAdmin(request: FastifyRequest): Promise<void> {
  if (request.auth?.user.is_admin !== 1) {
    throw forbidden('ADMIN_REQUIRED', 'Administrator access is required');
  }
}

export function currentUser(request: FastifyRequest): UserRow {
  if (!request.auth) throw unauthorized();
  return request.auth.user;
}
