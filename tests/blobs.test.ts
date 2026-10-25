import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { TestContext } from './helpers.js';
import {
  auth,
  createFile,
  createTestApp,
  createVault,
  type Session,
  setupAdmin,
  sha256,
  uploadBlob,
} from './helpers.js';

describe('blob storage', () => {
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

  test('uploads content-addressed blobs and deduplicates them', async () => {
    const first = await uploadBlob(ctx.app, owner.accessToken, vault.id, 'hello world');
    expect(first.statusCode).toBe(201);
    expect(first.body).toMatchObject({ hash: first.hash, deduped: false, size: 11 });

    const second = await uploadBlob(ctx.app, owner.accessToken, vault.id, 'hello world');
    expect(second.statusCode).toBe(200);
    expect(second.body).toMatchObject({ hash: first.hash, deduped: true, size: 11 });

    const head = await ctx.app.inject({
      method: 'HEAD',
      url: `/v1/vaults/${vault.id}/blobs/${first.hash}`,
      headers: auth(owner.accessToken),
    });
    expect(head.statusCode).toBe(200);
    expect(head.headers['x-syncy-blob-exists']).toBe('true');

    const missingHead = await ctx.app.inject({
      method: 'HEAD',
      url: `/v1/vaults/${vault.id}/blobs/${'f'.repeat(64)}`,
      headers: auth(owner.accessToken),
    });
    expect(missingHead.statusCode).toBe(404);
  });

  test('rejects content that does not match the hash', async () => {
    const expected = sha256('expected content');
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/vaults/${vault.id}/blobs/${expected}`,
      headers: { ...auth(owner.accessToken), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('different content'),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BLOB_HASH_MISMATCH');
  });

  test('serves full blobs, ranges and ETags', async () => {
    const created = await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-1',
      path: 'Note.md',
      content: 'hello world',
    });

    const full = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/blobs/${created.hash}`,
      headers: auth(owner.accessToken),
    });
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers.etag).toBe(`"${created.hash}"`);
    expect(full.rawPayload.toString()).toBe('hello world');

    const range = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/blobs/${created.hash}`,
      headers: { ...auth(owner.accessToken), range: 'bytes=0-4' },
    });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe('bytes 0-4/11');
    expect(range.rawPayload.toString()).toBe('hello');

    const suffix = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/blobs/${created.hash}`,
      headers: { ...auth(owner.accessToken), range: 'bytes=-5' },
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.toString()).toBe('world');

    const invalid = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/blobs/${created.hash}`,
      headers: { ...auth(owner.accessToken), range: 'bytes=100-200' },
    });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */11');

    const cached = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/blobs/${created.hash}`,
      headers: { ...auth(owner.accessToken), 'if-none-match': `"${created.hash}"` },
    });
    expect(cached.statusCode).toBe(304);
  });

  test('only serves blobs referenced by the requested vault', async () => {
    const otherVault = await createVault(ctx.app, owner.accessToken, { name: 'Other' });
    const uploaded = await uploadBlob(ctx.app, owner.accessToken, otherVault.id, 'secret bytes');

    const beforeReference = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${otherVault.id}/blobs/${uploaded.hash}`,
      headers: auth(owner.accessToken),
    });
    expect(beforeReference.statusCode).toBe(404);

    await createFile(ctx.app, owner.accessToken, vault.id, {
      fileId: 'file-1',
      path: 'Note.md',
      content: 'secret bytes',
    });

    const inOtherVault = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/blobs/${uploaded.hash}`,
      headers: auth(owner.accessToken),
    });
    expect(inOtherVault.statusCode).toBe(200);
  });
});
