import type { Db } from '../db/index.js';
import {
  type FileKind,
  type FileRow,
  type FileSummary,
  getFile,
  toFileSummary,
} from '../db/sync.js';
import { getVault } from '../db/vaults.js';
import { badRequest, notFound } from '../errors.js';
import { isSha256 } from '../utils/hash.js';
import { newId } from '../utils/ids.js';
import { normalizeEncryptedPath, normalizePlaintextPath } from '../utils/path.js';
import type { LocalBlobStore } from './blobStore.js';

export interface ChangeInput {
  fileId: string;
  path: string;
  kind: FileKind;
  encrypted?: boolean;
  hash?: string | null;
  size?: number;
  mtime?: number;
  ctime?: number;
  deleted?: boolean;
  expectedRevision?: number | null;
}

export interface SyncConflict {
  fileId: string;
  code: string;
  message: string;
  server?: FileSummary;
}

export type ChangeStatus = 'applied' | 'conflict' | 'skipped' | 'rejected';

export interface ChangeResult {
  fileId: string;
  status: ChangeStatus;
  revision?: number;
  versionId?: string;
  reason?: string;
  conflict?: SyncConflict;
}

export interface ApplyChangesResult {
  vaultId: string;
  previousRevision: number;
  revision: number;
  applied: boolean;
  hasConflicts: boolean;
  results: ChangeResult[];
  conflicts: SyncConflict[];
}

interface Candidate {
  index: number;
  change: ChangeInput;
  current: FileRow | undefined;
  path: string;
  pathKey: string | null;
  kind: FileKind;
  encrypted: boolean;
  hash: string | null;
  size: number;
  mtime: number;
  ctime: number;
  deleted: boolean;
  rejected: boolean;
}

function expectedRevisionConflict(
  change: ChangeInput,
  current: FileRow | undefined,
): SyncConflict | null {
  const expected = change.expectedRevision;

  if (expected === undefined) return null;

  if (expected === null) {
    if (current && current.deleted === 0) {
      return {
        fileId: change.fileId,
        code: 'already_exists',
        message: 'A live file with this id already exists',
        server: toFileSummary(current),
      };
    }
    return null;
  }

  if (!current) {
    return {
      fileId: change.fileId,
      code: 'not_found',
      message: 'The file does not exist on the server',
    };
  }

  if (current.rev !== expected) {
    return {
      fileId: change.fileId,
      code: 'revision_mismatch',
      message: 'The file has changed on the server since the expected revision',
      server: toFileSummary(current),
    };
  }

  return null;
}

function conflictResult(conflict: SyncConflict): ChangeResult {
  return {
    fileId: conflict.fileId,
    status: 'conflict',
    conflict,
  };
}

function detectPathConflicts(
  db: Db,
  vaultId: string,
  candidates: Candidate[],
): { conflicts: SyncConflict[]; rejected: Set<Candidate> } {
  const conflicts: SyncConflict[] = [];
  const rejected = new Set<Candidate>();
  if (candidates.length === 0) return { conflicts, rejected };

  const byFileId = new Map(candidates.map((candidate) => [candidate.change.fileId, candidate]));

  for (;;) {
    const liveFiles = db
      .prepare('SELECT * FROM files WHERE vault_id = ? AND deleted = 0 AND encrypted = 0')
      .all(vaultId) as FileRow[];

    const desired = new Map<string, Array<{ candidate: Candidate | null; row: FileRow | null }>>();

    const add = (
      key: string | null,
      entry: { candidate: Candidate | null; row: FileRow | null },
    ) => {
      if (!key) return;
      const existing = desired.get(key);
      if (existing) existing.push(entry);
      else desired.set(key, [entry]);
    };

    for (const row of liveFiles) {
      const candidate = byFileId.get(row.file_id);
      if (candidate && !candidate.rejected) {
        if (!candidate.deleted) {
          add(candidate.pathKey, { candidate, row });
        }
      } else {
        add(row.path_key, { candidate: null, row });
      }
    }

    let changed = false;

    for (const [pathKey, entries] of desired) {
      if (entries.length <= 1) continue;

      const unchanged = entries.find((entry) => entry.candidate === null);

      if (unchanged?.row) {
        const server = toFileSummary(unchanged.row);
        for (const entry of entries) {
          const candidate = entry.candidate;
          if (!candidate || candidate.rejected) continue;
          candidate.rejected = true;
          rejected.add(candidate);
          const conflict: SyncConflict = {
            fileId: candidate.change.fileId,
            code: 'path_taken',
            message: 'This path is already used by another file in the vault',
            server,
          };
          conflicts.push(conflict);
          changed = true;
        }
        continue;
      }

      const candidateEntries = entries
        .filter((entry) => entry.candidate !== null)
        .sort((a, b) => a.candidate!.index - b.candidate!.index);
      const keep = candidateEntries[0]?.candidate;
      if (!keep) continue;

      for (const entry of candidateEntries.slice(1)) {
        const candidate = entry.candidate!;
        if (candidate.rejected) continue;
        candidate.rejected = true;
        rejected.add(candidate);
        const conflict: SyncConflict = {
          fileId: candidate.change.fileId,
          code: 'path_taken',
          message: `Another file in this batch is also moving to "${pathKey}"`,
          server: keep.current ? toFileSummary(keep.current) : undefined,
        };
        conflicts.push(conflict);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return { conflicts, rejected };
}

export async function applyChanges(
  db: Db,
  blobs: LocalBlobStore,
  input: {
    vaultId: string;
    deviceId: string | null;
    changes: ChangeInput[];
    atomic: boolean;
  },
): Promise<ApplyChangesResult> {
  const { vaultId, deviceId, changes, atomic } = input;

  const seen = new Set<string>();
  const blobSizes = new Map<string, number>();

  for (const change of changes) {
    if (seen.has(change.fileId)) {
      throw badRequest('DUPLICATE_FILE_ID', `Duplicate fileId in batch: ${change.fileId}`);
    }
    seen.add(change.fileId);

    if (change.deleted) continue;

    if (change.kind === 'file') {
      if (!change.hash || !isSha256(change.hash)) {
        throw badRequest('INVALID_BLOB_HASH', 'File changes require a SHA-256 content hash');
      }
      if (!blobSizes.has(change.hash)) {
        const info = await blobs.stat(change.hash);
        if (!info) {
          throw badRequest('BLOB_MISSING', 'Upload the file blob before pushing its change', {
            hash: change.hash,
          });
        }
        blobSizes.set(change.hash, info.size);
      }
    } else if (change.hash) {
      throw badRequest('INVALID_FOLDER', 'Folder changes must not include a content hash');
    }
  }

  const transaction = db.transaction((): ApplyChangesResult => {
    const vault = getVault(db, vaultId);
    if (!vault) throw notFound('VAULT_NOT_FOUND', 'Vault not found');

    const previousRevision = vault.revision;
    const now = Date.now();
    const e2ee = vault.e2ee === 1;
    const results: ChangeResult[] = new Array(changes.length);
    const conflicts: SyncConflict[] = [];
    const candidates: Candidate[] = [];

    for (let index = 0; index < changes.length; index++) {
      const change = changes[index]!;
      const current = getFile(db, vaultId, change.fileId);

      const expectedConflict = expectedRevisionConflict(change, current);
      if (expectedConflict) {
        results[index] = conflictResult(expectedConflict);
        conflicts.push(expectedConflict);
        continue;
      }

      if (change.encrypted !== undefined && Boolean(change.encrypted) !== e2ee) {
        throw badRequest(
          'ENCRYPTION_MISMATCH',
          `Vault encryption mode is ${e2ee ? 'enabled' : 'disabled'}`,
        );
      }

      if (change.deleted) {
        if (!current || current.deleted === 1) {
          results[index] = {
            fileId: change.fileId,
            status: 'skipped',
            reason: 'already_deleted',
          };
          continue;
        }

        candidates.push({
          index,
          change,
          current,
          path: current.path,
          pathKey: current.path_key,
          kind: current.kind,
          encrypted: current.encrypted === 1,
          hash: null,
          size: 0,
          mtime: current.mtime,
          ctime: current.ctime,
          deleted: true,
          rejected: false,
        });
        continue;
      }

      const normalized = e2ee ? null : normalizePlaintextPath(change.path);
      const path = e2ee ? normalizeEncryptedPath(change.path) : normalized!.path;
      const pathKey = e2ee ? null : normalized!.pathKey;

      let hash: string | null = null;
      let size = 0;
      if (change.kind === 'file') {
        hash = change.hash ?? null;
        size = blobSizes.get(hash ?? '') ?? 0;
      }

      candidates.push({
        index,
        change,
        current,
        path,
        pathKey,
        kind: change.kind,
        encrypted: e2ee,
        hash,
        size,
        mtime: change.mtime ?? current?.mtime ?? now,
        ctime: change.ctime ?? current?.ctime ?? now,
        deleted: false,
        rejected: false,
      });
    }

    if (!e2ee && candidates.length > 0) {
      const { conflicts: pathConflicts, rejected } = detectPathConflicts(db, vaultId, candidates);
      for (const conflict of pathConflicts) {
        conflicts.push(conflict);
        const candidate = candidates.find((entry) => entry.change.fileId === conflict.fileId);
        if (candidate) results[candidate.index] = conflictResult(conflict);
      }

      for (const candidate of rejected) {
        if (!results[candidate.index]) {
          results[candidate.index] = conflictResult({
            fileId: candidate.change.fileId,
            code: 'path_taken',
            message: 'This path is already used by another file in the vault',
          });
        }
      }
    }

    if (atomic && conflicts.length > 0) {
      for (const candidate of candidates) {
        if (candidate.rejected) continue;
        results[candidate.index] = {
          fileId: candidate.change.fileId,
          status: 'rejected',
          reason: 'atomic_batch_rejected',
        };
      }

      return {
        vaultId,
        previousRevision,
        revision: previousRevision,
        applied: false,
        hasConflicts: true,
        results,
        conflicts,
      };
    }

    const accepted = candidates.filter((candidate) => !candidate.rejected);
    if (accepted.length === 0) {
      return {
        vaultId,
        previousRevision,
        revision: previousRevision,
        applied: false,
        hasConflicts: conflicts.length > 0,
        results,
        conflicts,
      };
    }

    if (!e2ee) {
      const clearPathKey = db.prepare(
        'UPDATE files SET path_key = NULL WHERE vault_id = ? AND file_id = ?',
      );
      for (const candidate of accepted) {
        if (candidate.current) clearPathKey.run(vaultId, candidate.change.fileId);
      }
    }

    const upsertFile = db.prepare(
      `INSERT INTO files
        (vault_id, file_id, path, path_key, kind, encrypted, hash, size, mtime, ctime, rev, deleted, last_device_id, updated_at)
       VALUES
        (@vault_id, @file_id, @path, @path_key, @kind, @encrypted, @hash, @size, @mtime, @ctime, @rev, @deleted, @last_device_id, @updated_at)
       ON CONFLICT(vault_id, file_id) DO UPDATE SET
         path = excluded.path,
         path_key = excluded.path_key,
         kind = excluded.kind,
         encrypted = excluded.encrypted,
         hash = excluded.hash,
         size = excluded.size,
         mtime = excluded.mtime,
         ctime = excluded.ctime,
         rev = excluded.rev,
         deleted = excluded.deleted,
         last_device_id = excluded.last_device_id,
         updated_at = excluded.updated_at`,
    );
    const insertVersion = db.prepare(
      `INSERT INTO versions
        (id, vault_id, file_id, revision, path, kind, encrypted, hash, size, mtime, ctime, deleted, device_id, created_at)
       VALUES
        (@id, @vault_id, @file_id, @revision, @path, @kind, @encrypted, @hash, @size, @mtime, @ctime, @deleted, @device_id, @created_at)`,
    );
    const insertChange = db.prepare(
      `INSERT INTO changes (vault_id, revision, file_id, version_id, device_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    let revision = previousRevision;

    for (const candidate of accepted) {
      revision += 1;
      const versionId = newId();
      const createdAt = Date.now();

      upsertFile.run({
        vault_id: vaultId,
        file_id: candidate.change.fileId,
        path: candidate.path,
        path_key: candidate.pathKey,
        kind: candidate.kind,
        encrypted: candidate.encrypted ? 1 : 0,
        hash: candidate.hash,
        size: candidate.size,
        mtime: candidate.mtime,
        ctime: candidate.ctime,
        rev: revision,
        deleted: candidate.deleted ? 1 : 0,
        last_device_id: deviceId,
        updated_at: createdAt,
      });

      insertVersion.run({
        id: versionId,
        vault_id: vaultId,
        file_id: candidate.change.fileId,
        revision,
        path: candidate.path,
        kind: candidate.kind,
        encrypted: candidate.encrypted ? 1 : 0,
        hash: candidate.hash,
        size: candidate.size,
        mtime: candidate.mtime,
        ctime: candidate.ctime,
        deleted: candidate.deleted ? 1 : 0,
        device_id: deviceId,
        created_at: createdAt,
      });

      insertChange.run(vaultId, revision, candidate.change.fileId, versionId, deviceId, createdAt);

      results[candidate.index] = {
        fileId: candidate.change.fileId,
        status: 'applied',
        revision,
        versionId,
      };
    }

    db.prepare('UPDATE vaults SET revision = ?, updated_at = ? WHERE id = ?').run(
      revision,
      Date.now(),
      vaultId,
    );

    return {
      vaultId,
      previousRevision,
      revision,
      applied: true,
      hasConflicts: conflicts.length > 0,
      results,
      conflicts,
    };
  });

  return transaction.immediate();
}
