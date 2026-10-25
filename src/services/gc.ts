import type { Db } from '../db/index.js';
import { collectReferencedHashes } from '../db/sync.js';
import { pruneRefreshTokens } from '../db/tokens.js';
import type { LocalBlobStore } from './blobStore.js';

export interface GcOptions {
  retentionDays: number;
  graceHours: number;
  apply: boolean;
  vacuum?: boolean;
  now?: number;
}

export interface GcResult {
  apply: boolean;
  retentionDays: number;
  graceHours: number;
  prunedVersions: number;
  prunedChanges: number;
  prunedRefreshTokens: number;
  unreferencedBlobs: number;
  deletedBlobs: number;
  freedBytes: number;
  vacuumed: boolean;
}

interface VersionCandidate {
  id: string;
  vault_id: string;
  revision: number;
  hash: string | null;
}

export async function runGc(db: Db, blobs: LocalBlobStore, options: GcOptions): Promise<GcResult> {
  const now = options.now ?? Date.now();
  const cutoff = now - options.retentionDays * 86_400_000;
  let prunedVersions = 0;
  let prunedChanges = 0;
  let prunedRefreshTokens = 0;
  let candidates: VersionCandidate[] = [];

  if (options.retentionDays > 0) {
    candidates = db
      .prepare(
        `SELECT v.id, v.vault_id, v.revision, v.hash
         FROM versions v
         WHERE v.created_at < ?
           AND v.revision < (
             SELECT MAX(v2.revision) FROM versions v2
             WHERE v2.vault_id = v.vault_id AND v2.file_id = v.file_id
           )`,
      )
      .all(cutoff) as VersionCandidate[];

    const maxRevisionByVault = new Map<string, number>();
    for (const candidate of candidates) {
      const current = maxRevisionByVault.get(candidate.vault_id) ?? 0;
      if (candidate.revision > current) {
        maxRevisionByVault.set(candidate.vault_id, candidate.revision);
      }
    }

    if (options.apply && candidates.length > 0) {
      db.transaction(() => {
        const deleteVersion = db.prepare('DELETE FROM versions WHERE id = ?');
        for (const candidate of candidates) deleteVersion.run(candidate.id);

        for (const [vaultId, maxRevision] of maxRevisionByVault) {
          const result = db
            .prepare('DELETE FROM changes WHERE vault_id = ? AND revision <= ?')
            .run(vaultId, maxRevision);
          prunedChanges += result.changes;
          db.prepare(
            'UPDATE vaults SET pruned_before_rev = MAX(pruned_before_rev, ?) WHERE id = ?',
          ).run(maxRevision, vaultId);
        }
      })();
    } else if (!options.apply) {
      for (const [vaultId, maxRevision] of maxRevisionByVault) {
        const row = db
          .prepare('SELECT COUNT(*) AS count FROM changes WHERE vault_id = ? AND revision <= ?')
          .get(vaultId, maxRevision) as { count: number };
        prunedChanges += row.count;
      }
    }

    prunedVersions = candidates.length;
  }

  const referenced = collectReferencedHashes(db);
  if (!options.apply && candidates.length > 0) {
    const counts = new Map<string, number>();
    const add = (hash: string | null) => {
      if (!hash) return;
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
    };

    const fileRows = db.prepare('SELECT hash FROM files WHERE hash IS NOT NULL').all() as Array<{
      hash: string;
    }>;
    for (const row of fileRows) add(row.hash);

    const versionRows = db
      .prepare('SELECT hash FROM versions WHERE hash IS NOT NULL')
      .all() as Array<{
      hash: string;
    }>;
    for (const row of versionRows) add(row.hash);

    for (const candidate of candidates) {
      if (!candidate.hash) continue;
      const next = (counts.get(candidate.hash) ?? 0) - 1;
      counts.set(candidate.hash, next);
      if (next <= 0) referenced.delete(candidate.hash);
    }
  }

  const graceCutoff = now - options.graceHours * 3_600_000;
  const blobList = await blobs.list();
  const unreferenced = blobList.filter(
    (blob) => !referenced.has(blob.hash) && blob.mtimeMs < graceCutoff,
  );

  let deletedBlobs = 0;
  let freedBytes = 0;

  if (options.apply) {
    for (const blob of unreferenced) {
      if (await blobs.remove(blob.hash)) {
        deletedBlobs += 1;
        freedBytes += blob.size;
      }
    }
    prunedRefreshTokens = pruneRefreshTokens(db);
  }

  let vacuumed = false;
  if (options.apply && options.vacuum) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    vacuumed = true;
  }

  return {
    apply: options.apply,
    retentionDays: options.retentionDays,
    graceHours: options.graceHours,
    prunedVersions,
    prunedChanges,
    prunedRefreshTokens,
    unreferencedBlobs: unreferenced.length,
    deletedBlobs,
    freedBytes,
    vacuumed,
  };
}
