import { jwtVerify, SignJWT } from 'jose';
import type { Config } from '../config.js';
import type { UserRow } from '../db/users.js';
import { unauthorized } from '../errors.js';

export interface VerifiedAccessToken {
  userId: string;
  email: string;
  isAdmin: boolean;
  deviceId: string | null;
  tokenVersion: number;
  expiresAt: number;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: number;
  expiresIn: number;
}

function secretKey(config: Config): Uint8Array {
  return new TextEncoder().encode(config.jwtSecret);
}

export async function signAccessToken(
  config: Config,
  user: UserRow,
  deviceId: string | null,
): Promise<IssuedAccessToken> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + config.accessTokenTtlSeconds;

  const token = await new SignJWT({
    email: user.email,
    isAdmin: user.is_admin === 1,
    deviceId,
    tokenVersion: user.token_version,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer('syncy')
    .setAudience('syncy-client')
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(secretKey(config));

  return {
    token,
    expiresAt: expiresAt * 1000,
    expiresIn: config.accessTokenTtlSeconds,
  };
}

export async function verifyAccessToken(
  config: Config,
  token: string,
): Promise<VerifiedAccessToken> {
  try {
    const { payload } = await jwtVerify(token, secretKey(config), {
      algorithms: ['HS256'],
      issuer: 'syncy',
      audience: 'syncy-client',
      clockTolerance: 5,
    });

    if (typeof payload.sub !== 'string') {
      throw unauthorized('TOKEN_INVALID', 'Access token is invalid');
    }

    return {
      userId: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      isAdmin: payload.isAdmin === true,
      deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : null,
      tokenVersion: typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0,
      expiresAt: typeof payload.exp === 'number' ? payload.exp * 1000 : Date.now(),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'JWTExpired') {
      throw unauthorized('TOKEN_EXPIRED', 'Access token has expired');
    }
    throw unauthorized('TOKEN_INVALID', 'Access token is invalid');
  }
}
