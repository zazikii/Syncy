import { badRequest } from '../errors.js';

const MAX_PATH_LENGTH = 2048;
const MAX_ENCRYPTED_PATH_LENGTH = 16_384;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export interface NormalizedPath {
  path: string;
  pathKey: string;
}

export function normalizePlaintextPath(input: string): NormalizedPath {
  if (typeof input !== 'string') {
    throw badRequest('INVALID_PATH', 'path must be a string');
  }

  const normalized = input.replace(/\\/g, '/').normalize('NFC');

  if (normalized.length === 0 || normalized.length > MAX_PATH_LENGTH) {
    throw badRequest('INVALID_PATH', `path must be between 1 and ${MAX_PATH_LENGTH} characters`);
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw badRequest('INVALID_PATH', 'path must be relative to the vault root');
  }
  if (hasControlCharacters(normalized)) {
    throw badRequest('INVALID_PATH', 'path must not contain control characters');
  }

  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw badRequest('INVALID_PATH', 'path must not contain parent directory segments');
  }

  const path = segments.join('/');
  return { path, pathKey: path.toLowerCase() };
}

export function normalizeEncryptedPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_ENCRYPTED_PATH_LENGTH) {
    throw badRequest(
      'INVALID_PATH',
      `encrypted path must be between 1 and ${MAX_ENCRYPTED_PATH_LENGTH} characters`,
    );
  }
  if (hasControlCharacters(input)) {
    throw badRequest('INVALID_PATH', 'encrypted path must not contain control characters');
  }
  return input;
}
