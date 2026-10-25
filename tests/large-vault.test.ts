import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { TestContext } from './helpers.js';
import {
  auth,
  createTestApp,
  createVault,
  pushChanges,
  type Session,
  setupAdmin,
} from './helpers.js';

describe('large vault reliability', () => {
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

  test('handles a 1200-file batch and paginates the snapshot', async () => {
    const changes = Array.from({ length: 1200 }, (_, index) => ({
      fileId: `file-${String(index).padStart(4, '0')}`,
      path: `Folder ${String(index).padStart(4, '0')}`,
      kind: 'folder' as const,
      expectedRevision: null,
    }));

    const pushed = await pushChanges(ctx.app, owner.accessToken, vault.id, changes, true);
    expect(pushed.statusCode).toBe(200);
    expect(pushed.body.revision).toBe(1200);

    const seen = new Set<string>();
    let cursor: string | null = null;
    let revision = 0;
    let pages = 0;

    for (;;) {
      const query = new URLSearchParams({ limit: '500' });
      if (cursor) query.set('cursor', cursor);
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/v1/vaults/${vault.id}/files?${query.toString()}`,
        headers: auth(owner.accessToken),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        revision: number;
        hasMore: boolean;
        nextCursor: string | null;
        files: Array<{ fileId: string }>;
      };
      if (pages === 0) revision = body.revision;
      expect(body.revision).toBe(revision);
      for (const file of body.files) seen.add(file.fileId);
      pages += 1;
      if (!body.hasMore) break;
      cursor = body.nextCursor;
      expect(cursor).toBeTruthy();
    }

    expect(pages).toBe(3);
    expect(seen.size).toBe(1200);

    const firstChanges = await ctx.app.inject({
      method: 'GET',
      url: `/v1/vaults/${vault.id}/changes?since=0&limit=500`,
      headers: auth(owner.accessToken),
    });
    expect(firstChanges.statusCode).toBe(200);
    expect(firstChanges.json()).toMatchObject({ revision: 1200, hasMore: true, nextCursor: 500 });
    expect(firstChanges.json().changes).toHaveLength(500);
  });
});
