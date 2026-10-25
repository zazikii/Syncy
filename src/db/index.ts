import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from '../config.js';

export type Db = Database.Database;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        platform TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX devices_user_id ON devices(user_id);

      CREATE TABLE refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
        family_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX refresh_tokens_user_id ON refresh_tokens(user_id);
      CREATE INDEX refresh_tokens_family_id ON refresh_tokens(family_id);
      CREATE INDEX refresh_tokens_expires_at ON refresh_tokens(expires_at);

      CREATE TABLE vaults (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        e2ee INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        pruned_before_rev INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX vaults_owner_id ON vaults(owner_id);

      CREATE TABLE vault_members (
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'reader')),
        key_envelope TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (vault_id, user_id)
      );
      CREATE INDEX vault_members_user_id ON vault_members(user_id);

      CREATE TABLE files (
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL,
        path TEXT NOT NULL,
        path_key TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
        encrypted INTEGER NOT NULL DEFAULT 0,
        hash TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        ctime INTEGER NOT NULL DEFAULT 0,
        rev INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        last_device_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (vault_id, file_id)
      );
      CREATE INDEX files_path_key ON files(vault_id, path_key);
      CREATE UNIQUE INDEX files_live_path_unique ON files(vault_id, path_key)
        WHERE deleted = 0 AND encrypted = 0 AND path_key IS NOT NULL;
      CREATE INDEX files_live ON files(vault_id, deleted);
      CREATE INDEX files_updated_at ON files(vault_id, updated_at);

      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
        encrypted INTEGER NOT NULL DEFAULT 0,
        hash TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        ctime INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        device_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (vault_id, file_id) REFERENCES files(vault_id, file_id) ON DELETE CASCADE
      );
      CREATE INDEX versions_file ON versions(vault_id, file_id, revision DESC);
      CREATE INDEX versions_hash ON versions(vault_id, hash);
      CREATE INDEX versions_created_at ON versions(created_at);

      CREATE TABLE changes (
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        file_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        device_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (vault_id, revision)
      );
      CREATE INDEX changes_file_id ON changes(vault_id, file_id);
      CREATE INDEX changes_created_at ON changes(created_at);
    `,
  },
];

export function openDatabase(config: Config): Db {
  mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  let current = db.pragma('user_version', { simple: true }) as number;

  for (const migration of migrations) {
    if (migration.version <= current) continue;

    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      run();
      current = migration.version;
    } catch (error) {
      throw new Error(`Database migration ${migration.name} failed`, { cause: error });
    }
  }
}
