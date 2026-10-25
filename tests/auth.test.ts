import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { TestContext } from './helpers.js';
import { auth, createTestApp, login, setupAdmin } from './helpers.js';

describe('authentication', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('first-run setup creates an administrator and cannot run twice', async () => {
    const session = await setupAdmin(ctx.app);
    expect(session.accessToken).toBeTruthy();
    expect(session.user.isAdmin).toBe(true);
    expect(session.deviceId).toBeTruthy();

    const info = await ctx.app.inject({ method: 'GET', url: '/v1/info' });
    expect(info.json()).toMatchObject({ setupRequired: false, registrationOpen: false });

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/v1/setup',
      payload: { email: 'other@example.com', password: 'another-password-123' },
    });
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe('SETUP_COMPLETE');
  });

  test('setup can require a setup token', async () => {
    await ctx.close();
    ctx = await createTestApp({ SETUP_TOKEN: 'super-secret-token' });

    const denied = await ctx.app.inject({
      method: 'POST',
      url: '/v1/setup',
      payload: { email: 'admin@example.com', password: 'admin-password-123' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('INVALID_SETUP_TOKEN');

    const allowed = await ctx.app.inject({
      method: 'POST',
      url: '/v1/setup',
      headers: { 'x-setup-token': 'super-secret-token' },
      payload: { email: 'admin@example.com', password: 'admin-password-123' },
    });
    expect(allowed.statusCode).toBe(201);
  });

  test('login rejects wrong credentials and accepts the configured account', async () => {
    await setupAdmin(ctx.app);

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@example.com', password: 'wrong-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'wrong-password' },
    });
    expect(unknown.statusCode).toBe(401);

    const session = await login(ctx.app, 'admin@example.com', 'admin-password-123');
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: auth(session.accessToken),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('admin@example.com');
  });

  test('refresh tokens rotate and detect reuse', async () => {
    const session = await setupAdmin(ctx.app);

    const firstRefresh = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(firstRefresh.statusCode).toBe(200);
    const rotated = firstRefresh.json();
    expect(rotated.refreshToken).not.toBe(session.refreshToken);

    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe('REFRESH_TOKEN_REUSED');

    const familyRevoked = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(familyRevoked.statusCode).toBe(401);
  });

  test('logout revokes the refresh token', async () => {
    const session = await setupAdmin(ctx.app);

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken: session.refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });

  test('password change revokes refresh tokens and requires the current password', async () => {
    const session = await setupAdmin(ctx.app);

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: auth(session.accessToken),
      payload: { currentPassword: 'wrong', newPassword: 'new-password-123' },
    });
    expect(wrong.statusCode).toBe(401);

    const changed = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: auth(session.accessToken),
      payload: { currentPassword: 'admin-password-123', newPassword: 'new-password-123' },
    });
    expect(changed.statusCode).toBe(204);

    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);

    const oldAccess = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: auth(session.accessToken),
    });
    expect(oldAccess.statusCode).toBe(401);
    expect(oldAccess.json().error.code).toBe('TOKEN_REVOKED');

    const newLogin = await login(ctx.app, 'admin@example.com', 'new-password-123');
    expect(newLogin.accessToken).toBeTruthy();
  });

  test('logout-all revokes refresh and access tokens', async () => {
    const session = await setupAdmin(ctx.app);

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: auth(session.accessToken),
    });
    expect(logout.statusCode).toBe(204);

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: auth(session.accessToken),
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe('TOKEN_REVOKED');

    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });

  test('registration is closed by default and can be enabled', async () => {
    await setupAdmin(ctx.app);

    const closed = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'new@example.com', password: 'new-password-123' },
    });
    expect(closed.statusCode).toBe(403);
    expect(closed.json().error.code).toBe('REGISTRATION_DISABLED');

    await ctx.close();
    ctx = await createTestApp({ ALLOW_REGISTRATION: 'true' });
    await setupAdmin(ctx.app);

    const open = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'new@example.com',
        password: 'new-password-123',
        device: { name: 'New device' },
      },
    });
    expect(open.statusCode).toBe(201);
    expect(open.json().user.isAdmin).toBe(false);
  });

  test('a configured .env user is created automatically', async () => {
    await ctx.close();
    ctx = await createTestApp({
      SYNCY_EMAIL: 'owner@example.com',
      SYNCY_PASSWORD: 'owner-password-123',
      SYNCY_NAME: 'Owner',
    });

    const info = await ctx.app.inject({ method: 'GET', url: '/v1/info' });
    expect(info.json().setupRequired).toBe(false);

    const session = await login(ctx.app, 'owner@example.com', 'owner-password-123');
    expect(session.user.isAdmin).toBe(true);
    expect(session.user.displayName).toBe('Owner');
  });

  test('disabled accounts cannot authenticate or use existing access tokens', async () => {
    const session = await setupAdmin(ctx.app);

    ctx.app.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(session.user.id);

    const loginAttempt = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@example.com', password: 'admin-password-123' },
    });
    expect(loginAttempt.statusCode).toBe(403);
    expect(loginAttempt.json().error.code).toBe('ACCOUNT_DISABLED');

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: auth(session.accessToken),
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe('ACCOUNT_DISABLED');
  });
});
