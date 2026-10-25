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

describe('vaults and members', () => {
  let ctx: TestContext;
  let owner: Session;
  let vault: { id: string };

  beforeEach(async () => {
    ctx = await createTestApp();
    owner = await setupAdmin(ctx.app);
    vault = await createVault(ctx.app, owner.accessToken, { name: 'Notes' });
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('creates, lists, reads, renames and deletes vaults', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/vaults',
      headers: auth(owner.accessToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().vaults).toHaveLength(1);
    expect(list.json().vaults[0]).toMatchObject({ id: vault.id, role: 'owner', e2ee: false });

    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/vaults/${vault.id}`,
      headers: auth(owner.accessToken),
      payload: { name: 'Renamed vault' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().vault.name).toBe('Renamed vault');

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/vaults/${vault.id}`,
      headers: auth(owner.accessToken),
    });
    expect(deleted.statusCode).toBe(204);

    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}`,
      headers: auth(owner.accessToken),
    });
    expect(missing.statusCode).toBe(404);
  });

  test('shares a vault with readers and enforces roles', async () => {
    await createDbUser(ctx.app, 'reader@example.com', 'reader-password-123');
    const reader = await login(ctx.app, 'reader@example.com', 'reader-password-123');

    const added = await ctx.app.inject({
      method: 'POST',
      url: `/v1/vaults/${vault.id}/members`,
      headers: auth(owner.accessToken),
      payload: {
        email: 'reader@example.com',
        role: 'reader',
        keyEnvelope: 'reader-envelope',
      },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().member).toMatchObject({ role: 'reader', hasKeyEnvelope: true });

    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: `/v1/vaults/${vault.id}/members`,
      headers: auth(owner.accessToken),
      payload: { email: 'reader@example.com', role: 'editor' },
    });
    expect(duplicate.statusCode).toBe(409);

    const readerVault = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}`,
      headers: auth(reader.accessToken),
    });
    expect(readerVault.statusCode).toBe(200);
    expect(readerVault.json().vault).toMatchObject({
      role: 'reader',
      keyEnvelope: 'reader-envelope',
    });

    const readerMembers = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/members`,
      headers: auth(reader.accessToken),
    });
    expect(readerMembers.statusCode).toBe(200);
    const ownerEntry = readerMembers
      .json()
      .members.find((member: { userId: string }) => member.userId === owner.user.id);
    expect(ownerEntry.keyEnvelope).toBeUndefined();

    const readerPush = await ctx.app.inject({
      method: 'POST',
      url: `/v1/vaults/${vault.id}/changes`,
      headers: auth(reader.accessToken),
      payload: {
        changes: [
          {
            fileId: 'folder-1',
            path: 'Folder',
            kind: 'folder',
            expectedRevision: null,
          },
        ],
      },
    });
    expect(readerPush.statusCode).toBe(403);
    expect(readerPush.json().error.code).toBe('INSUFFICIENT_ROLE');

    const readerRename = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/vaults/${vault.id}`,
      headers: auth(reader.accessToken),
      payload: { name: 'Hijacked' },
    });
    expect(readerRename.statusCode).toBe(403);
  });

  test('owners can change roles and key envelopes, members can leave', async () => {
    await createDbUser(ctx.app, 'member@example.com', 'member-password-123');
    const member = await login(ctx.app, 'member@example.com', 'member-password-123');

    await ctx.app.inject({
      method: 'POST',
      url: `/v1/vaults/${vault.id}/members`,
      headers: auth(owner.accessToken),
      payload: { email: 'member@example.com', role: 'reader' },
    });

    const promoted = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/vaults/${vault.id}/members/${member.user.id}`,
      headers: auth(owner.accessToken),
      payload: { role: 'editor', keyEnvelope: 'new-envelope' },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().member).toMatchObject({ role: 'editor', keyEnvelope: 'new-envelope' });

    const memberVault = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}`,
      headers: auth(member.accessToken),
    });
    expect(memberVault.json().vault).toMatchObject({
      role: 'editor',
      keyEnvelope: 'new-envelope',
    });

    const selfPatchRole = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/vaults/${vault.id}/members/${member.user.id}`,
      headers: auth(member.accessToken),
      payload: { role: 'reader' },
    });
    expect(selfPatchRole.statusCode).toBe(403);

    const leave = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/vaults/${vault.id}/members/${member.user.id}`,
      headers: auth(member.accessToken),
    });
    expect(leave.statusCode).toBe(204);

    const afterLeave = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}`,
      headers: auth(member.accessToken),
    });
    expect(afterLeave.statusCode).toBe(404);
  });

  test('the owner cannot leave and non-members cannot read the vault', async () => {
    const leave = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/vaults/${vault.id}/members/${owner.user.id}`,
      headers: auth(owner.accessToken),
    });
    expect(leave.statusCode).toBe(409);

    await createDbUser(ctx.app, 'stranger@example.com', 'stranger-password-123');
    const stranger = await login(ctx.app, 'stranger@example.com', 'stranger-password-123');

    const access = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}`,
      headers: auth(stranger.accessToken),
    });
    expect(access.statusCode).toBe(404);
  });

  test('e2ee vaults keep owner key envelopes and report them to members', async () => {
    const e2eeVault = await createVault(ctx.app, owner.accessToken, {
      name: 'Encrypted',
      e2ee: true,
      keyEnvelope: 'owner-wrapped-key',
    });

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${e2eeVault.id}`,
      headers: auth(owner.accessToken),
    });
    expect(fetched.json().vault).toMatchObject({ e2ee: true, keyEnvelope: 'owner-wrapped-key' });
  });
});
