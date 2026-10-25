import type { ScryptOptions } from 'node:crypto';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function deriveKey(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await deriveKey(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [algorithm, n, r, p, salt, expected] = stored.split('$');
    if (algorithm !== 'scrypt' || !n || !r || !p || !salt || !expected) return false;

    const nValue = Number.parseInt(n, 10);
    const rValue = Number.parseInt(r, 10);
    const pValue = Number.parseInt(p, 10);
    if (!Number.isFinite(nValue) || !Number.isFinite(rValue) || !Number.isFinite(pValue))
      return false;
    if (nValue < 2 ** 14 || nValue > 2 ** 20) return false;

    const saltBuffer = Buffer.from(salt, 'base64url');
    const expectedBuffer = Buffer.from(expected, 'base64url');
    if (expectedBuffer.length !== KEY_LENGTH) return false;

    const derivedKey = await deriveKey(password, saltBuffer, {
      N: nValue,
      r: rValue,
      p: pValue,
      maxmem: MAX_MEMORY,
    });

    return timingSafeEqual(derivedKey, expectedBuffer);
  } catch {
    return false;
  }
}
