import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { TestContext } from './helpers.js';
import { auth, createTestApp, login, type Session, setupAdmin } from './helpers.js';

describe('devices', () => {
  let ctx: TestContext;
  let session: Session;

  beforeEach(async () => {
    ctx = await createTestApp();
    await setupAdmin(ctx.app);
    session = await login(ctx.app, 'admin@example.com', 'admin-password-123');
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('lists and renames devices', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: auth(session.accessToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().currentDeviceId).toBe(session.deviceId);
    expect(list.json().devices).toHaveLength(2);

    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/devices/${session.deviceId}`,
      headers: auth(session.accessToken),
      payload: { name: 'Renamed device' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().device.name).toBe('Renamed device');
  });

  test('removing a device invalidates its access token', async () => {
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${session.deviceId}`,
      headers: auth(session.accessToken),
    });
    expect(removed.statusCode).toBe(204);

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: auth(session.accessToken),
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe('DEVICE_REVOKED');

    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });
});
