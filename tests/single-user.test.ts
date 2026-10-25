import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { login } from './helpers.js';

describe('single-user .env configuration', () => {
  test('creates the user and applies password changes on restart', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'syncy-single-user-'));
    const jwtSecret = 'single-user-test-secret-'.repeat(4);
    const baseEnv = {
      NODE_ENV: 'test',
      DATA_DIR: dir,
      JWT_SECRET: jwtSecret,
      SYNCY_EMAIL: 'owner@example.com',
      SYNCY_NAME: 'Vault Owner',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: '100000',
    };

    const firstConfig = loadConfig({ ...baseEnv, SYNCY_PASSWORD: 'first-password-123' });
    const firstApp = await buildApp({ config: firstConfig, logger: false });

    try {
      const firstLogin = await login(firstApp, 'owner@example.com', 'first-password-123');
      expect(firstLogin.user.isAdmin).toBe(true);
      expect(firstLogin.user.displayName).toBe('Vault Owner');

      const secondConfig = loadConfig({ ...baseEnv, SYNCY_PASSWORD: 'second-password-123' });
      const secondApp = await buildApp({ config: secondConfig, logger: false });

      try {
        const oldPassword = await secondApp.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: 'owner@example.com', password: 'first-password-123' },
        });
        expect(oldPassword.statusCode).toBe(401);

        const newPassword = await login(secondApp, 'owner@example.com', 'second-password-123');
        expect(newPassword.accessToken).toBeTruthy();

        const revokedRefresh = await secondApp.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          payload: { refreshToken: firstLogin.refreshToken },
        });
        expect(revokedRefresh.statusCode).toBe(401);

        const revokedAccess = await secondApp.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers: { authorization: `Bearer ${firstLogin.accessToken}` },
        });
        expect(revokedAccess.statusCode).toBe(401);
        expect(revokedAccess.json().error.code).toBe('TOKEN_REVOKED');

        const secondUser = secondApp.db.prepare('SELECT COUNT(*) AS count FROM users').get() as {
          count: number;
        };
        expect(secondUser.count).toBe(1);
      } finally {
        await secondApp.close();
      }
    } finally {
      await firstApp.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
