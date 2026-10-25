import { randomBytes } from 'node:crypto';
import { unauthorized } from '../errors.js';
import { sha256Hex } from '../utils/hash.js';
import { newId } from '../utils/ids.js';
import type { Db } from './index.js';

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  device_id: string | null;
  family_id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface IssuedRefreshToken {
  token: string;
  row: RefreshTokenRow;
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return sha256Hex(token);
}

export function findRefreshTokenByHash(db: Db, tokenHash: string): RefreshTokenRow | undefined {
  return db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(tokenHash) as
    | RefreshTokenRow
    | undefined;
}

export function issueRefreshToken(
  db: Db,
  userId: string,
  deviceId: string | null,
  ttlDays: number,
  familyId = newId(),
): IssuedRefreshToken {
  const now = Date.now();
  const token = generateToken();
  const row: RefreshTokenRow = {
    id: newId(),
    user_id: userId,
    device_id: deviceId,
    family_id: familyId,
    token_hash: hashRefreshToken(token),
    created_at: now,
    expires_at: now + ttlDays * 86_400_000,
    last_used_at: null,
    revoked_at: null,
  };

  db.prepare(
    `INSERT INTO refresh_tokens
      (id, user_id, device_id, family_id, token_hash, created_at, expires_at, last_used_at, revoked_at)
     VALUES (@id, @user_id, @device_id, @family_id, @token_hash, @created_at, @expires_at, @last_used_at, @revoked_at)`,
  ).run(row);

  return { token, row };
}

export function rotateRefreshToken(
  db: Db,
  token: string,
  ttlDays: number,
): { issued: IssuedRefreshToken; userId: string; deviceId: string | null } {
  const existing = findRefreshTokenByHash(db, hashRefreshToken(token));
  if (!existing) {
    throw unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
  }

  const now = Date.now();

  if (existing.revoked_at !== null) {
    revokeFamily(db, existing.family_id);
    throw unauthorized('REFRESH_TOKEN_REUSED', 'Refresh token has already been used');
  }

  if (existing.expires_at <= now) {
    throw unauthorized('REFRESH_TOKEN_EXPIRED', 'Refresh token has expired');
  }

  const issued = db.transaction(() => {
    db.prepare('UPDATE refresh_tokens SET revoked_at = ?, last_used_at = ? WHERE id = ?').run(
      now,
      now,
      existing.id,
    );
    return issueRefreshToken(db, existing.user_id, existing.device_id, ttlDays, existing.family_id);
  })();

  return { issued, userId: existing.user_id, deviceId: existing.device_id };
}

export function revokeRefreshToken(db: Db, token: string): void {
  db.prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
  ).run(Date.now(), hashRefreshToken(token));
}

export function revokeFamily(db: Db, familyId: string): void {
  db.prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
  ).run(Date.now(), familyId);
}

export function revokeAllForUser(db: Db, userId: string): void {
  db.prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
  ).run(Date.now(), userId);
}

export function revokeDeviceTokens(db: Db, userId: string, deviceId: string): void {
  db.prepare(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL',
  ).run(Date.now(), userId, deviceId);
}

export function pruneRefreshTokens(db: Db): number {
  const now = Date.now();
  const cutoff = now - 30 * 86_400_000;
  const result = db
    .prepare(
      'DELETE FROM refresh_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
    )
    .run(cutoff, cutoff);
  return result.changes;
}
