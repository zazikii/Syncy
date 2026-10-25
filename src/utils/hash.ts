import { createHash } from 'node:crypto';

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}
