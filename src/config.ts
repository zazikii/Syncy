import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const SERVER_NAME = 'syncy';
export const SERVER_VERSION = '0.1.0';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return fallback;
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
      ctx.addIssue({ code: 'custom', message: `Invalid boolean value: ${value}` });
      return z.NEVER;
    });

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATA_DIR: z.string().default('./data'),
  PUBLIC_URL: optionalString,
  JWT_SECRET: optionalString,
  SETUP_TOKEN: optionalString,
  SYNCY_EMAIL: optionalString,
  SYNCY_PASSWORD: optionalString,
  SYNCY_NAME: optionalString,
  ADMIN_EMAIL: optionalString,
  ADMIN_PASSWORD: optionalString,
  ALLOW_REGISTRATION: bool(false),
  CORS_ORIGINS: optionalString,
  MAX_BLOB_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(512 * 1024 * 1024),
  MAX_JSON_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(6000),
  TRUST_PROXY: bool(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface ConfiguredUser {
  email: string;
  password: string;
  name: string;
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  blobDir: string;
  publicUrl: string;
  jwtSecret: string;
  setupToken: string | null;
  configuredUser: ConfiguredUser | null;
  allowRegistration: boolean;
  corsOrigins: string[];
  maxBlobBytes: number;
  maxJsonBodyBytes: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  rateLimitMax: number;
  trustProxy: boolean;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

function loadOrCreateJwtSecret(dataDir: string, provided?: string): string {
  if (provided) {
    if (provided.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters long');
    }
    return provided;
  }

  const secretPath = path.join(dataDir, '.jwt-secret');
  if (existsSync(secretPath)) {
    const secret = readFileSync(secretPath, 'utf8').trim();
    if (secret.length < 32) {
      throw new Error(`JWT secret at ${secretPath} is too short`);
    }
    return secret;
  }

  const secret = randomBytes(48).toString('base64url');
  writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  return secret;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function loadLocalDotEnv(env: NodeJS.ProcessEnv): void {
  if (env !== process.env) return;

  try {
    process.loadEnvFile(path.resolve(process.cwd(), '.env'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw error;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadLocalDotEnv(env);
  const raw = envSchema.parse(env);
  const dataDir = path.resolve(raw.DATA_DIR);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const email = raw.SYNCY_EMAIL ?? raw.ADMIN_EMAIL;
  const password = raw.SYNCY_PASSWORD ?? raw.ADMIN_PASSWORD;

  if ((email && !password) || (!email && password)) {
    throw new Error('SYNCY_EMAIL and SYNCY_PASSWORD must be set together');
  }
  if (password && password.length < 10) {
    throw new Error('SYNCY_PASSWORD must be at least 10 characters long');
  }

  const configuredUser: ConfiguredUser | null =
    email && password
      ? {
          email: normalizeEmail(email),
          password,
          name: raw.SYNCY_NAME?.trim() || email.split('@')[0] || 'Syncy User',
        }
      : null;

  const corsOrigins = raw.CORS_ORIGINS
    ? raw.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [];

  return {
    nodeEnv: raw.NODE_ENV,
    host: raw.HOST,
    port: raw.PORT,
    dataDir,
    dbPath: path.join(dataDir, 'syncy.db'),
    blobDir: path.join(dataDir, 'blobs'),
    publicUrl: (raw.PUBLIC_URL ?? `http://localhost:${raw.PORT}`).replace(/\/+$/, ''),
    jwtSecret: loadOrCreateJwtSecret(dataDir, raw.JWT_SECRET),
    setupToken: raw.SETUP_TOKEN ?? null,
    configuredUser,
    allowRegistration: raw.ALLOW_REGISTRATION,
    corsOrigins,
    maxBlobBytes: raw.MAX_BLOB_BYTES,
    maxJsonBodyBytes: raw.MAX_JSON_BODY_BYTES,
    accessTokenTtlSeconds: raw.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: raw.REFRESH_TOKEN_TTL_DAYS,
    rateLimitMax: raw.RATE_LIMIT_MAX,
    trustProxy: raw.TRUST_PROXY,
    logLevel: raw.LOG_LEVEL,
  };
}
