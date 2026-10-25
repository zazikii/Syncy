import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { hashPassword } from './auth/password.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { collectReferencedHashes } from './db/sync.js';
import { pruneRefreshTokens } from './db/tokens.js';
import { createUser, findUserByEmail, listUsers, userCount } from './db/users.js';
import { countVaults } from './db/vaults.js';
import { LocalBlobStore } from './services/blobStore.js';

const HELP = `Syncy CLI

Usage:
  npm run cli -- <command> [options]

Commands:
  create-user --email <email> --password <password> [--name <name>] [--admin]
  list-users
  stats
  gc [--retention-days <days>] [--grace-hours <hours>] [--yes] [--vacuum]
  backup [--out <directory>] [--db-only]
  vacuum

Environment:
  DATA_DIR, JWT_SECRET, and other server variables are read from the environment/.env.
  For create-user, --password may be omitted when SYNCY_CLI_PASSWORD is set.
`;

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function requireOption(values: Record<string, string | boolean>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`Missing --${name}`);
  }
  return value;
}

function parseNumberOption(
  values: Record<string, string | boolean>,
  name: string,
  fallback: number,
): number {
  const value = values[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') fail(`--${name} requires a value`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`--${name} must be a non-negative number`);
  return parsed;
}

async function createUserCommand(values: Record<string, string | boolean>): Promise<void> {
  const config = loadConfig();
  const email = requireOption(values, 'email').trim().toLowerCase();
  const password =
    (typeof values.password === 'string' ? values.password : undefined) ??
    process.env.SYNCY_CLI_PASSWORD;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Invalid email address');
  if (!password || password.length < 10) fail('Password must be at least 10 characters long');

  const db = openDatabase(config);
  try {
    if (findUserByEmail(db, email)) fail(`A user with email ${email} already exists`);
    const user = createUser(db, {
      email,
      passwordHash: await hashPassword(password),
      displayName: typeof values.name === 'string' ? values.name : null,
      isAdmin: values.admin === true,
    });
    console.log(`Created user ${user.email} (${user.id})${user.is_admin === 1 ? ' [admin]' : ''}`);
  } finally {
    db.close();
  }
}

function listUsersCommand(): void {
  const config = loadConfig();
  const db = openDatabase(config);
  try {
    const page = listUsers(db, { limit: 10_000, offset: 0 });
    console.log(JSON.stringify(page.users, null, 2));
  } finally {
    db.close();
  }
}

async function statsCommand(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config);
  const blobs = new LocalBlobStore(config.blobDir, config.maxBlobBytes);
  await blobs.init();
  try {
    const blobList = await blobs.list();
    const deviceRow = db.prepare('SELECT COUNT(*) AS count FROM devices').get() as {
      count: number;
    };
    console.log(
      JSON.stringify(
        {
          users: userCount(db),
          vaults: countVaults(db),
          devices: deviceRow.count,
          blobs: blobList.length,
          storageBytes: blobList.reduce((total, blob) => total + blob.size, 0),
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}

async function gcCommand(values: Record<string, string | boolean>): Promise<void> {
  const config = loadConfig();
  const retentionDays = parseNumberOption(values, 'retention-days', 0);
  const graceHours = parseNumberOption(values, 'grace-hours', 24);
  const apply = values.yes === true;
  const vacuum = values.vacuum === true;

  const db = openDatabase(config);
  const blobs = new LocalBlobStore(config.blobDir, config.maxBlobBytes);
  await blobs.init();

  const now = Date.now();
  const cutoff = now - retentionDays * 86_400_000;
  let prunedVersions = 0;
  let prunedChanges = 0;
  let prunedRefreshTokens = 0;

  try {
    if (retentionDays > 0) {
      const candidates = db
        .prepare(
          `SELECT v.id, v.vault_id, v.revision
           FROM versions v
           WHERE v.created_at < ?
             AND v.revision < (
               SELECT MAX(v2.revision) FROM versions v2
               WHERE v2.vault_id = v.vault_id AND v2.file_id = v.file_id
             )`,
        )
        .all(cutoff) as Array<{ id: string; vault_id: string; revision: number }>;

      const maxRevisionByVault = new Map<string, number>();
      for (const candidate of candidates) {
        const current = maxRevisionByVault.get(candidate.vault_id) ?? 0;
        if (candidate.revision > current) {
          maxRevisionByVault.set(candidate.vault_id, candidate.revision);
        }
      }

      if (apply && candidates.length > 0) {
        const prune = db.transaction(() => {
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
        });
        prune();
      }

      prunedVersions = candidates.length;
    }

    const referenced = collectReferencedHashes(db);
    const blobList = await blobs.list();
    const graceCutoff = now - graceHours * 3_600_000;
    const unreferenced = blobList.filter(
      (blob) => !referenced.has(blob.hash) && blob.mtimeMs < graceCutoff,
    );

    let deletedBlobs = 0;
    let freedBytes = 0;
    if (apply) {
      for (const blob of unreferenced) {
        if (await blobs.remove(blob.hash)) {
          deletedBlobs += 1;
          freedBytes += blob.size;
        }
      }
      prunedRefreshTokens += pruneRefreshTokens(db);
    }

    console.log(
      JSON.stringify(
        {
          apply,
          retentionDays,
          graceHours,
          prunedVersions,
          prunedChanges,
          prunedRefreshTokens,
          unreferencedBlobs: unreferenced.length,
          deletedBlobs,
          freedBytes,
          tip: apply ? undefined : 'Dry run. Re-run with --yes to apply.',
        },
        null,
        2,
      ),
    );

    if (apply && vacuum) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      console.log('Database vacuumed');
    }
  } finally {
    db.close();
  }
}

async function backupCommand(values: Record<string, string | boolean>): Promise<void> {
  const config = loadConfig();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir =
    typeof values.out === 'string'
      ? path.resolve(values.out)
      : path.resolve(config.dataDir, 'backups', stamp);
  const dbOnly = values['db-only'] === true;

  await mkdir(outputDir, { recursive: true });

  const db = openDatabase(config);
  try {
    await db.backup(path.join(outputDir, 'syncy.db'));
  } finally {
    db.close();
  }

  if (!dbOnly) {
    await cp(config.blobDir, path.join(outputDir, 'blobs'), { recursive: true, force: true });
  }
  await cp(path.join(config.dataDir, '.jwt-secret'), path.join(outputDir, '.jwt-secret'), {
    force: true,
  }).catch(() => undefined);

  console.log(`Backup written to ${outputDir}${dbOnly ? ' (database only)' : ''}`);
}

async function vacuumCommand(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    console.log('Database vacuumed');
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === '--help' || command === 'help') {
    console.log(HELP);
    return;
  }

  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      name: { type: 'string' },
      admin: { type: 'boolean' },
      'retention-days': { type: 'string' },
      'grace-hours': { type: 'string' },
      yes: { type: 'boolean' },
      vacuum: { type: 'boolean' },
      out: { type: 'string' },
      'db-only': { type: 'boolean' },
    },
    allowPositionals: false,
  });

  switch (command) {
    case 'create-user':
      await createUserCommand(values);
      break;
    case 'list-users':
      listUsersCommand();
      break;
    case 'stats':
      await statsCommand();
      break;
    case 'gc':
      await gcCommand(values);
      break;
    case 'backup':
      await backupCommand(values);
      break;
    case 'vacuum':
      await vacuumCommand();
      break;
    default:
      fail(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
