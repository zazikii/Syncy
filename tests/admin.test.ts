import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { TestContext } from './helpers.js';
import { auth, createDbUser, createTestApp, login, type Session, setupAdmin } from './helpers.js';

describe('admin API', () => {
  let ctx: TestContext;
  let admin: Session;

  beforeEach(async () => {
    ctx = await createTestApp();
    admin = await setupAdmin(ctx.app);
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('reports stats and lists users for administrators only', async () => {
    const stats = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/stats',
      headers: auth(admin.accessToken),
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toMatchObject({ users: 1, vaults: 0, blobs: 0 });

    const users = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/users?limit=10&offset=0',
      headers: auth(admin.accessToken),
    });
    expect(users.statusCode).toBe(200);
    expect(users.json().total).toBe(1);
    expect(users.json().users[0].email).toBe('admin@example.com');

    await createDbUser(ctx.app, 'user@example.com', 'user-password-123');
    const user = await login(ctx.app, 'user@example.com', 'user-password-123');

    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/stats',
      headers: auth(user.accessToken),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('ADMIN_REQUIRED');
  });

  test('prevents self-lockout and protects the last administrator', async () => {
    const disableSelf = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${admin.user.id}`,
      headers: auth(admin.accessToken),
      payload: { disabled: true },
    });
    expect(disableSelf.statusCode).toBe(409);
    expect(disableSelf.json().error.code).toBe('CANNOT_DISABLE_SELF');

    const demoteSelf = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${admin.user.id}`,
      headers: auth(admin.accessToken),
      payload: { isAdmin: false },
    });
    expect(demoteSelf.statusCode).toBe(409);
    expect(demoteSelf.json().error.code).toBe('CANNOT_DEMOTE_SELF');

    const secondAdmin = await createDbUser(
      ctx.app,
      'second-admin@example.com',
      'second-admin-password',
      true,
    );

    const disableSecond = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${secondAdmin.id}`,
      headers: auth(admin.accessToken),
      payload: { disabled: true },
    });
    expect(disableSecond.statusCode).toBe(200);
    expect(disableSecond.json().user.disabled).toBe(true);
  });

  test('disabling a user revokes their access tokens', async () => {
    const target = await createDbUser(ctx.app, 'target@example.com', 'target-password-123');
    const targetSession = await login(ctx.app, 'target@example.com', 'target-password-123');

    const disabled = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${target.id}`,
      headers: auth(admin.accessToken),
      payload: { disabled: true },
    });
    expect(disabled.statusCode).toBe(200);

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: auth(targetSession.accessToken),
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe('ACCOUNT_DISABLED');

    const reenabled = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${target.id}`,
      headers: auth(admin.accessToken),
      payload: { disabled: false },
    });
    expect(reenabled.statusCode).toBe(200);

    const stillRevoked = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: auth(targetSession.accessToken),
    });
    expect(stillRevoked.statusCode).toBe(401);
    expect(stillRevoked.json().error.code).toBe('TOKEN_REVOKED');
  });
});
