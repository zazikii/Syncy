import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { TestContext } from './helpers.js';
import {
  auth,
  createFile,
  createTestApp,
  createVault,
  pullChanges,
  pushChanges,
  type Session,
  setupAdmin,
  uploadBlob,
} from './helpers.js';

describe('sync engine', () => {
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

  test('creates files, returns changes and a consistent snapshot', async () => {
    const created = await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-1',
      path: 'Notes/Hello.md',
      content: '# Hello\n',
    });

    expect(created.push.statusCode).toBe(200);
    expect(created.push.body).toMatchObject({
      applied: true,
      revision: 1,
      previousRevision: 0,
      hasConflicts: false,
    });
    expect(created.push.body.results[0]).toMatchObject({ status: 'applied', revision: 1 });

    const changes = await pullChanges(ctx.app, owner.accessToken, vault.id, 0);
    expect(changes.statusCode).toBe(200);
    expect(changes.body.revision).toBe(1);
    expect(changes.body.hasMore).toBe(false);
    expect(changes.body.changes).toHaveLength(1);
    expect(changes.body.changes[0]).toMatchObject({
      revision: 1,
      fileId: 'file-1',
      path: 'Notes/Hello.md',
      hash: created.hash,
      deleted: false,
    });

    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files`,
      headers: auth(owner.accessToken),
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      revision: 1,
      files: [{ fileId: 'file-1', path: 'Notes/Hello.md', hash: created.hash, deleted: false }],
    });

    const download = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/blobs/${created.hash}`,
      headers: auth(owner.accessToken),
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.toString()).toBe('# Hello\n');

    const versions = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files/file-1/versions`,
      headers: auth(owner.accessToken),
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().versions).toHaveLength(1);
    expect(versions.json().versions[0]).toMatchObject({ revision: 1, hash: created.hash });
  });

  test('paginates snapshots for large vaults', async () => {
    const pushed = await pushChanges(
      ctx.app,
      owner.accessToken,
      vault.id,
      [
        { fileId: 'file-a', path: 'A', kind: 'folder', expectedRevision: null },
        { fileId: 'file-b', path: 'B', kind: 'folder', expectedRevision: null },
        { fileId: 'file-c', path: 'C', kind: 'folder', expectedRevision: null },
      ],
      true,
    );
    expect(pushed.statusCode).toBe(200);
    expect(pushed.body.revision).toBe(3);

    const firstPage = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files?limit=2`,
      headers: auth(owner.accessToken),
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({
      revision: 3,
      hasMore: true,
      nextCursor: 'file-b',
    });
    expect(firstPage.json().files.map((file: { fileId: string }) => file.fileId)).toEqual([
      'file-a',
      'file-b',
    ]);

    const secondPage = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files?limit=2&cursor=file-b`,
      headers: auth(owner.accessToken),
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json()).toMatchObject({
      revision: 3,
      hasMore: false,
      nextCursor: null,
    });
    expect(secondPage.json().files.map((file: { fileId: string }) => file.fileId)).toEqual([
      'file-c',
    ]);

    const emptyPage = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files?limit=2&cursor=file-c`,
      headers: auth(owner.accessToken),
    });
    expect(emptyPage.statusCode).toBe(200);
    expect(emptyPage.json()).toMatchObject({ hasMore: false, nextCursor: null, files: [] });
  });

  test('detects revision conflicts and supports non-atomic partial batches', async () => {
    await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-1',
      path: 'One.md',
      content: 'one',
    });

    const second = await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-1',
      path: 'One.md',
      content: 'two',
      expectedRevision: 1,
    });
    expect(second.push.statusCode).toBe(200);
    expect(second.push.body.revision).toBe(2);

    const stale = await pushChanges(
      ctx.app,
      owner.accessToken,
      vault.id,
      [
        {
          fileId: 'file-1',
          path: 'One.md',
          kind: 'file',
          hash: second.hash,
          expectedRevision: 1,
        },
      ],
      true,
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.body.applied).toBe(false);
    expect(stale.body.conflicts[0]).toMatchObject({ fileId: 'file-1', code: 'revision_mismatch' });
    expect(stale.body.conflicts[0]?.server?.revision).toBe(2);

    const partial = await pushChanges(
      ctx.app,
      owner.accessToken,
      vault.id,
      [
        {
          fileId: 'file-1',
          path: 'One.md',
          kind: 'file',
          hash: second.hash,
          expectedRevision: 1,
        },
        {
          fileId: 'folder-1',
          path: 'Folder',
          kind: 'folder',
          expectedRevision: null,
        },
      ],
      false,
    );
    expect(partial.statusCode).toBe(200);
    expect(partial.body.applied).toBe(true);
    expect(partial.body.revision).toBe(3);
    expect(partial.body.conflicts).toHaveLength(1);
    expect(partial.body.results[1]).toMatchObject({ status: 'applied', revision: 3 });

    const changes = await pullChanges(ctx.app, owner.accessToken, vault.id, 2);
    expect(changes.body.changes).toHaveLength(1);
    expect(changes.body.changes[0]).toMatchObject({ fileId: 'folder-1', kind: 'folder' });
  });

  test('rejects path conflicts and rolls back atomic batches', async () => {
    const first = await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-1',
      path: 'One.md',
      content: 'one',
    });
    await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-2',
      path: 'Two.md',
      content: 'two',
    });

    const pathConflict = await pushChanges(ctx.app, owner.accessToken, vault.id, [
      {
        fileId: 'file-1',
        path: 'Two.md',
        kind: 'file',
        hash: first.hash,
        expectedRevision: 1,
      },
    ]);
    expect(pathConflict.statusCode).toBe(409);
    expect(pathConflict.body.conflicts[0]?.code).toBe('path_taken');

    const rolledBack = await pushChanges(
      ctx.app,
      owner.accessToken,
      vault.id,
      [
        {
          fileId: 'file-3',
          path: 'Three.md',
          kind: 'folder',
          expectedRevision: null,
        },
        {
          fileId: 'file-1',
          path: 'Two.md',
          kind: 'file',
          hash: first.hash,
          expectedRevision: 1,
        },
      ],
      true,
    );
    expect(rolledBack.statusCode).toBe(409);
    expect(rolledBack.body.applied).toBe(false);
    expect(rolledBack.body.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'atomic_batch_rejected',
    });

    const stillMissing = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files`,
      headers: auth(owner.accessToken),
    });
    expect(stillMissing.json().files).toHaveLength(2);
    expect(stillMissing.json().revision).toBe(2);
  });

  test('supports atomic path swaps between files', async () => {
    const a = await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-a',
      path: 'A.md',
      content: 'a',
    });
    const b = await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-b',
      path: 'B.md',
      content: 'b',
    });

    const swapped = await pushChanges(
      ctx.app,
      owner.accessToken,
      vault.id,
      [
        {
          fileId: 'file-a',
          path: 'B.md',
          kind: 'file',
          hash: a.hash,
          expectedRevision: 1,
        },
        {
          fileId: 'file-b',
          path: 'A.md',
          kind: 'file',
          hash: b.hash,
          expectedRevision: 2,
        },
      ],
      true,
    );
    expect(swapped.statusCode).toBe(200);
    expect(swapped.body.revision).toBe(4);

    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files`,
      headers: auth(owner.accessToken),
    });
    const files = snapshot.json().files as Array<{ fileId: string; path: string }>;
    expect(files.find((file) => file.fileId === 'file-a')?.path).toBe('B.md');
    expect(files.find((file) => file.fileId === 'file-b')?.path).toBe('A.md');
  });

  test('deletes files, keeps tombstones and restores versions', async () => {
    const created = await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-1',
      path: 'Note.md',
      content: 'original',
    });

    const deleted = await pushChanges(ctx.app, owner.accessToken, vault.id, [
      {
        fileId: 'file-1',
        path: 'Note.md',
        kind: 'file',
        deleted: true,
        expectedRevision: 1,
      },
    ]);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body.revision).toBe(2);

    const liveSnapshot = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files`,
      headers: auth(owner.accessToken),
    });
    expect(liveSnapshot.json().files).toHaveLength(0);

    const fullSnapshot = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files?includeDeleted=true`,
      headers: auth(owner.accessToken),
    });
    expect(fullSnapshot.json().files).toHaveLength(1);
    expect(fullSnapshot.json().files[0]).toMatchObject({ fileId: 'file-1', deleted: true });

    const changes = await pullChanges(ctx.app, owner.accessToken, vault.id, 1);
    expect(changes.body.changes[0]).toMatchObject({ fileId: 'file-1', deleted: true });

    const versions = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files/file-1/versions`,
      headers: auth(owner.accessToken),
    });
    const version = versions.json().versions[0];
    expect(version).toMatchObject({ revision: 1, hash: created.hash, deleted: false });

    const restored = await ctx.app.inject({
      method: 'POST',
      url: `/v1/vaults/${vault.id}/files/file-1/versions/${version.id}/restore`,
      headers: auth(owner.accessToken),
      payload: {},
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ applied: true, revision: 3 });

    const restoredSnapshot = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/files`,
      headers: auth(owner.accessToken),
    });
    expect(restoredSnapshot.json().files[0]).toMatchObject({
      fileId: 'file-1',
      path: 'Note.md',
      hash: created.hash,
      deleted: false,
    });
  });

  test('supports end-to-end encrypted vaults with opaque paths', async () => {
    const e2eeVault = await createVault(ctx.app, owner.accessToken, {
      name: 'Encrypted',
      e2ee: true,
      keyEnvelope: 'wrapped-key',
    });

    const one = await uploadBlob(ctx.app, owner.accessToken, e2eeVault.id, 'ciphertext-one');
    const two = await uploadBlob(ctx.app, owner.accessToken, e2eeVault.id, 'ciphertext-two');

    const pushed = await pushChanges(
      ctx.app,
      owner.accessToken,
      e2eeVault.id,
      [
        {
          fileId: 'enc-file-1',
          path: 'encrypted-path-a',
          kind: 'file',
          encrypted: true,
          hash: one.hash,
          expectedRevision: null,
        },
        {
          fileId: 'enc-file-2',
          path: 'encrypted-path-a',
          kind: 'file',
          encrypted: true,
          hash: two.hash,
          expectedRevision: null,
        },
      ],
      true,
    );
    expect(pushed.statusCode).toBe(200);
    expect(pushed.body.revision).toBe(2);

    const changes = await pullChanges(ctx.app, owner.accessToken, e2eeVault.id, 0);
    expect(changes.body.changes).toHaveLength(2);
    expect(changes.body.changes[0]).toMatchObject({
      path: 'encrypted-path-a',
      encrypted: true,
    });

    const mismatch = await pushChanges(ctx.app, owner.accessToken, e2eeVault.id, [
      {
        fileId: 'enc-file-3',
        path: 'plaintext-path',
        kind: 'file',
        encrypted: false,
        hash: one.hash,
        expectedRevision: null,
      },
    ]);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body).toMatchObject({ error: { code: 'ENCRYPTION_MISMATCH' } });
  });

  test('validates blobs, paths and cursors', async () => {
    const missingBlob = await pushChanges(ctx.app, owner.accessToken, vault.id, [
      {
        fileId: 'file-1',
        path: 'Note.md',
        kind: 'file',
        hash: '0'.repeat(64),
        expectedRevision: null,
      },
    ]);
    expect(missingBlob.statusCode).toBe(400);
    expect(missingBlob.body).toMatchObject({ error: { code: 'BLOB_MISSING' } });

    const uploaded = await uploadBlob(ctx.app, owner.accessToken, vault.id, 'content');
    const traversal = await pushChanges(ctx.app, owner.accessToken, vault.id, [
      {
        fileId: 'file-1',
        path: '../escape.md',
        kind: 'file',
        hash: uploaded.hash,
        expectedRevision: null,
      },
    ]);
    expect(traversal.statusCode).toBe(400);
    expect(traversal.body).toMatchObject({ error: { code: 'INVALID_PATH' } });

    await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-1',
      path: 'Note.md',
      content: 'content',
    });

    ctx.app.db.prepare('UPDATE vaults SET pruned_before_rev = 1 WHERE id = ?').run(vault.id);

    const expired = await pullChanges(ctx.app, owner.accessToken, vault.id, 0);
    expect(expired.statusCode).toBe(410);
    expect(expired.body).toMatchObject({ error: { code: 'CURSOR_EXPIRED' } });

    const current = await pullChanges(ctx.app, owner.accessToken, vault.id, 1);
    expect(current.statusCode).toBe(200);

    const ahead = await pullChanges(ctx.app, owner.accessToken, vault.id, 999);
    expect(ahead.statusCode).toBe(410);
    expect(ahead.body).toMatchObject({ error: { code: 'CURSOR_AHEAD' } });
  });
});
