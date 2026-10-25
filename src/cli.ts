import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { hashPassword } from './auth/password.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createUser, findUserByEmail, listUsers, userCount } from './db/users.js';
import { countVaults } from './db/vaults.js';
import { LocalBlobStore } from './services/blobStore.js';
import { runGc } from './services/gc.js';

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

  try {
    const result = await runGc(db, blobs, {
      retentionDays,
      graceHours,
      apply,
      vacuum,
    });

    console.log(
      JSON.stringify(
        {
          ...result,
          tip: apply ? undefined : 'Dry run. Re-run with --yes to apply.',
        },
        null,
        2,
      ),
    );
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
    await mkdir(config.blobDir, { recursive: true, mode: 0o700 });
    const tempDir = path.join(config.blobDir, '.tmp');
    await cp(config.blobDir, path.join(outputDir, 'blobs'), {
      recursive: true,
      force: true,
      filter: (source) => source !== tempDir,
    });
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
