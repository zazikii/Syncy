import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { issueRefreshToken } from '../db/tokens.js';
import type { UserRow } from '../db/users.js';
import { toPublicUser } from '../db/users.js';
import { signAccessToken } from './jwt.js';

export interface SessionResponse {
  tokenType: 'Bearer';
  accessToken: string;
  accessTokenExpiresAt: number;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  deviceId: string | null;
  user: ReturnType<typeof toPublicUser>;
}

export async function issueSession(
  db: Db,
  config: Config,
  user: UserRow,
  deviceId: string | null,
): Promise<SessionResponse> {
  const access = await signAccessToken(config, user, deviceId);
  const refresh = issueRefreshToken(db, user.id, deviceId, config.refreshTokenTtlDays);

  return {
    tokenType: 'Bearer',
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    expiresIn: access.expiresIn,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.row.expires_at,
    deviceId,
    user: toPublicUser(user),
  };
}
