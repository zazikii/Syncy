import type { Db } from './index.js';

export type FileKind = 'file' | 'folder';

export interface FileRow {
  vault_id: string;
  file_id: string;
  path: string;
  path_key: string | null;
  kind: FileKind;
  encrypted: number;
  hash: string | null;
  size: number;
  mtime: number;
  ctime: number;
  rev: number;
  deleted: number;
  last_device_id: string | null;
  updated_at: number;
}

export interface VersionRow {
  id: string;
  vault_id: string;
  file_id: string;
  revision: number;
  path: string;
  kind: FileKind;
  encrypted: number;
  hash: string | null;
  size: number;
  mtime: number;
  ctime: number;
  deleted: number;
  device_id: string | null;
  created_at: number;
}

export interface ChangeRow {
  revision: number;
  file_id: string;
  version_id: string;
  device_id: string | null;
  created_at: number;
  path: string;
  kind: FileKind;
  encrypted: number;
  hash: string | null;
  size: number;
  mtime: number;
  ctime: number;
  deleted: number;
}

export interface FileSummary {
  fileId: string;
  path: string;
  kind: FileKind;
  encrypted: boolean;
  hash: string | null;
  size: number;
  mtime: number;
  ctime: number;
  revision: number;
  deleted: boolean;
  updatedAt: number;
}

export function toFileSummary(row: FileRow): FileSummary {
  return {
    fileId: row.file_id,
    path: row.path,
    kind: row.kind,
    encrypted: row.encrypted === 1,
    hash: row.hash,
    size: row.size,
    mtime: row.mtime,
    ctime: row.ctime,
    revision: row.rev,
    deleted: row.deleted === 1,
    updatedAt: row.updated_at,
  };
}

export function toChange(row: ChangeRow) {
  return {
    revision: row.revision,
    fileId: row.file_id,
    versionId: row.version_id,
    path: row.path,
    kind: row.kind,
    encrypted: row.encrypted === 1,
    hash: row.hash,
    size: row.size,
    mtime: row.mtime,
    ctime: row.ctime,
    deleted: row.deleted === 1,
    deviceId: row.device_id,
    createdAt: row.created_at,
  };
}

export function toVersion(row: VersionRow) {
  return {
    id: row.id,
    fileId: row.file_id,
    revision: row.revision,
    path: row.path,
    kind: row.kind,
    encrypted: row.encrypted === 1,
    hash: row.hash,
    size: row.size,
    mtime: row.mtime,
    ctime: row.ctime,
    deleted: row.deleted === 1,
    deviceId: row.device_id,
    createdAt: row.created_at,
  };
}

export function getFile(db: Db, vaultId: string, fileId: string): FileRow | undefined {
  return db
    .prepare('SELECT * FROM files WHERE vault_id = ? AND file_id = ?')
    .get(vaultId, fileId) as FileRow | undefined;
}

export interface FilePage {
  rows: FileRow[];
  hasMore: boolean;
}

export function listFilesPage(
  db: Db,
  vaultId: string,
  options: { includeDeleted: boolean; afterFileId: string; limit: number },
): FilePage {
  const deletedFilter = options.includeDeleted ? '' : 'AND deleted = 0';
  const rows = db
    .prepare(
      `SELECT * FROM files
       WHERE vault_id = ?
         ${deletedFilter}
         AND file_id > ?
       ORDER BY file_id ASC
       LIMIT ?`,
    )
    .all(vaultId, options.afterFileId, options.limit + 1) as FileRow[];

  const hasMore = rows.length > options.limit;
  return { rows: hasMore ? rows.slice(0, options.limit) : rows, hasMore };
}

export function listChanges(
  db: Db,
  vaultId: string,
  since: number,
  until: number,
  limit: number,
): ChangeRow[] {
  return db
    .prepare(
      `SELECT c.revision, c.file_id, c.version_id, c.device_id, c.created_at,
         v.path, v.kind, v.encrypted, v.hash, v.size, v.mtime, v.ctime, v.deleted
       FROM changes c
       JOIN versions v ON v.id = c.version_id
       WHERE c.vault_id = ? AND c.revision > ? AND c.revision <= ?
       ORDER BY c.revision ASC
       LIMIT ?`,
    )
    .all(vaultId, since, until, limit) as ChangeRow[];
}

export function listVersions(
  db: Db,
  vaultId: string,
  fileId: string,
  beforeRevision: number | null,
  limit: number,
): VersionRow[] {
  if (beforeRevision === null) {
    return db
      .prepare(
        `SELECT * FROM versions
         WHERE vault_id = ? AND file_id = ? AND deleted = 0
         ORDER BY revision DESC LIMIT ?`,
      )
      .all(vaultId, fileId, limit) as VersionRow[];
  }

  return db
    .prepare(
      `SELECT * FROM versions
       WHERE vault_id = ? AND file_id = ? AND deleted = 0 AND revision < ?
       ORDER BY revision DESC LIMIT ?`,
    )
    .all(vaultId, fileId, beforeRevision, limit) as VersionRow[];
}

export function getVersion(
  db: Db,
  vaultId: string,
  fileId: string,
  versionId: string,
): VersionRow | undefined {
  return db
    .prepare('SELECT * FROM versions WHERE id = ? AND vault_id = ? AND file_id = ?')
    .get(versionId, vaultId, fileId) as VersionRow | undefined;
}

export function blobReferenced(db: Db, vaultId: string, hash: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM versions WHERE vault_id = ? AND hash = ? LIMIT 1')
    .get(vaultId, hash);
  return row !== undefined;
}

export function collectReferencedHashes(db: Db): Set<string> {
  const hashes = new Set<string>();

  const fileRows = db.prepare('SELECT hash FROM files WHERE hash IS NOT NULL').all() as Array<{
    hash: string;
  }>;
  for (const row of fileRows) hashes.add(row.hash);

  const versionRows = db
    .prepare('SELECT hash FROM versions WHERE hash IS NOT NULL')
    .all() as Array<{
    hash: string;
  }>;
  for (const row of versionRows) hashes.add(row.hash);

  return hashes;
}
