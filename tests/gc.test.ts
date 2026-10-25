import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runGc } from '../src/services/gc.js';
import type { TestContext } from './helpers.js';
import {
  auth,
  createFile,
  createTestApp,
  createVault,
  pullChanges,
  type Session,
  setupAdmin,
} from './helpers.js';

describe('garbage collection', () => {
  let ctx: TestContext;
  let owner: Session;
  let vault: { id: string };
  let firstHash: string;
  let secondHash: string;
  let thirdHash: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    owner = await setupAdmin(ctx.app);
    vault = await createVault(ctx.app, owner.accessToken);

    const first = await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-1',
      path: 'Note.md',
      content: 'version one',
    });
    firstHash = first.hash!;

    const second = await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-1',
      path: 'Note.md',
      content: 'version two',
      expectedRevision: 1,
    });
    secondHash = second.hash!;

    const third = await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-1',
      path: 'Note.md',
      content: 'version three',
      expectedRevision: 2,
    });
    thirdHash = third.hash!;
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('prunes old versions, advances the cursor and deletes orphan blobs', async () => {
    const old = Date.now() - 90 * 86_400_000;
    ctx.app.db
      .prepare('UPDATE versions SET created_at = ? WHERE vault_id = ? AND revision IN (1, 2)')
      .run(old, vault.id);

    const dryRun = await runGc(ctx.app.db, ctx.app.blobs, {
      retentionDays: 30,
      graceHours: 0,
      apply: false,
      now: Date.now() + 1000,
    });

    expect(dryRun).toMatchObject({
      apply: false,
      prunedVersions: 2,
      prunedChanges: 2,
      unreferencedBlobs: 2,
      deletedBlobs: 0,
    });
    expect(await ctx.app.blobs.has(firstHash)).toBe(true);

    const applied = await runGc(ctx.app.db, ctx.app.blobs, {
      retentionDays: 30,
      graceHours: 0,
      apply: true,
      now: Date.now() + 1000,
    });

    expect(applied).toMatchObject({
      apply: true,
      prunedVersions: 2,
      prunedChanges: 2,
      deletedBlobs: 2,
    });
    expect(applied.freedBytes).toBeGreaterThan(0);

    expect(await ctx.app.blobs.has(firstHash)).toBe(false);
    expect(await ctx.app.blobs.has(secondHash)).toBe(false);
    expect(await ctx.app.blobs.has(thirdHash)).toBe(true);

    const vaultRow = ctx.app.db.prepare('SELECT * FROM vaults WHERE id = ?').get(vault.id) as {
      revision: number;
      pruned_before_rev: number;
    };
    expect(vaultRow.revision).toBe(3);
    expect(vaultRow.pruned_before_rev).toBe(2);

    const versions = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files/file-1/versions`,
      headers: auth(owner.accessToken),
    });
    expect(versions.json().versions).toHaveLength(1);
    expect(versions.json().versions[0].hash).toBe(thirdHash);

    const expired = await pullChanges(ctx.app, owner.accessToken, vault.id, 0);
    expect(expired.statusCode).toBe(410);
    expect(expired.body).toMatchObject({ error: { code: 'CURSOR_EXPIRED' } });

    const remaining = await pullChanges(ctx.app, owner.accessToken, vault.id, 2);
    expect(remaining.statusCode).toBe(200);
    expect(remaining.body.changes).toHaveLength(1);
    expect(remaining.body.changes[0]).toMatchObject({ revision: 3, hash: thirdHash });
  });

  test('does not prune versions when retention is disabled', async () => {
    const result = await runGc(ctx.app.db, ctx.app.blobs, {
      retentionDays: 0,
      graceHours: 0,
      apply: true,
      now: Date.now() + 1000,
    });

    expect(result).toMatchObject({ prunedVersions: 0, prunedChanges: 0 });
    expect(await ctx.app.blobs.has(firstHash)).toBe(true);
  });
});
