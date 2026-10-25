import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { TestContext } from './helpers.js';
import {
  auth,
  createDbUser,
  createTestApp,
  createVault,
  login,
  type Session,
  setupAdmin,
} from './helpers.js';

describe('vault settings', () => {
  let ctx: TestContext;
  let owner: Session;
  let vault: { id: string };

  beforeEach(async () => {
    ctx = await createTestApp();
    owner = await setupAdmin(ctx.app);
    vault = await createVault(ctx.app, owner.accessToken);
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('stores versioned vault settings with optimistic concurrency', async () => {
    const initial = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/settings`,
      headers: auth(owner.accessToken),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      vaultId: vault.id,
      revision: 0,
      settings: null,
      updatedAt: null,
      updatedByDevice: null,
    });

    const settings = {
      appearance: { theme: 'obsidian', baseFontSize: 17 },
      hotkeys: { 'app:toggle-left-sidebar': [{ modifiers: ['Mod'], key: 'B' }] },
      corePlugins: { graph: true, canvas: true },
      communityPlugins: {
        enabled: ['obsidian-git'],
        data: { 'obsidian-git': { autoPull: true } },
      },
      snippets: { enabled: ['wide.css'] },
    };

    const created = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/vaults/${vault.id}/settings`,
      headers: auth(owner.accessToken),
      payload: { settings, expectedRevision: null },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      vaultId: vault.id,
      revision: 1,
      settings,
      updatedByDevice: owner.deviceId,
    });

    const updated = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/vaults/${vault.id}/settings`,
      headers: auth(owner.accessToken),
      payload: {
        settings: { ...settings, appearance: { theme: 'moonstone' } },
        expectedRevision: 1,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ revision: 2 });

    const stale = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/vaults/${vault.id}/settings`,
      headers: auth(owner.accessToken),
      payload: { settings: { appearance: { theme: 'stale' } }, expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: {
        code: 'SETTINGS_CONFLICT',
        details: {
          currentRevision: 2,
          settings: { appearance: { theme: 'moonstone' } },
        },
      },
    });

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/settings`,
      headers: auth(owner.accessToken),
    });
    expect(fetched.json()).toMatchObject({
      revision: 2,
      settings: { appearance: { theme: 'moonstone' } },
    });
  });

  test('readers can fetch settings but cannot change them', async () => {
    await createDbUser(ctx.app, 'reader@example.com', 'reader-password-123');
    const reader = await login(ctx.app, 'reader@example.com', 'reader-password-123');

    await ctx.app.inject({
      method: 'POST',
      url: `/v1/vaults/${vault.id}/members`,
      headers: auth(owner.accessToken),
      payload: { email: 'reader@example.com', role: 'reader' },
    });

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/settings`,
      headers: auth(reader.accessToken),
    });
    expect(fetched.statusCode).toBe(200);

    const denied = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/vaults/${vault.id}/settings`,
      headers: auth(reader.accessToken),
      payload: { settings: { appearance: { theme: 'hijacked' } } },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('INSUFFICIENT_ROLE');
  });

  test('accepts opaque encrypted settings payloads for E2EE vaults', async () => {
    const e2eeVault = await createVault(ctx.app, owner.accessToken, {
      name: 'Encrypted',
      e2ee: true,
      keyEnvelope: 'owner-key',
    });

    const saved = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/vaults/${e2eeVault.id}/settings`,
      headers: auth(owner.accessToken),
      payload: {
        settings: { alg: 'xchacha20-poly1305', nonce: 'abc', ciphertext: 'def' },
        expectedRevision: null,
      },
    });
    expect(saved.statusCode).toBe(200);

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${e2eeVault.id}/settings`,
      headers: auth(owner.accessToken),
    });
    expect(fetched.json().settings).toMatchObject({ ciphertext: 'def' });
  });
});
