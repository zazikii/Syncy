import { newId } from '../utils/ids.js';
import type { Db } from './index.js';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  is_admin: number;
  disabled: number;
  created_at: number;
  updated_at: number;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    isAdmin: user.is_admin === 1,
    disabled: user.disabled === 1,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

export function userCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
}

export function adminCount(db: Db): number {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1 AND disabled = 0').get() as {
      count: number;
    }
  ).count;
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function findUserByEmail(db: Db, email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) as
    | UserRow
    | undefined;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  displayName?: string | null;
  isAdmin?: boolean;
}

export function createUser(db: Db, input: CreateUserInput): UserRow {
  const now = Date.now();
  const user: UserRow = {
    id: newId(),
    email: normalizeEmail(input.email),
    password_hash: input.passwordHash,
    display_name: input.displayName ?? null,
    is_admin: input.isAdmin ? 1 : 0,
    disabled: 0,
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, is_admin, disabled, created_at, updated_at)
     VALUES (@id, @email, @password_hash, @display_name, @is_admin, @disabled, @created_at, @updated_at)`,
  ).run(user);

  return user;
}

export function updateUserPassword(db: Db, userId: string, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    passwordHash,
    Date.now(),
    userId,
  );
}

export function updateUserDisplayName(db: Db, userId: string, displayName: string | null): void {
  db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(
    displayName,
    Date.now(),
    userId,
  );
}

export function updateUserFlags(
  db: Db,
  userId: string,
  flags: { isAdmin?: boolean; disabled?: boolean },
): UserRow | undefined {
  const current = findUserById(db, userId);
  if (!current) return undefined;

  db.prepare('UPDATE users SET is_admin = ?, disabled = ?, updated_at = ? WHERE id = ?').run(
    flags.isAdmin === undefined ? current.is_admin : flags.isAdmin ? 1 : 0,
    flags.disabled === undefined ? current.disabled : flags.disabled ? 1 : 0,
    Date.now(),
    userId,
  );

  return findUserById(db, userId);
}

export interface UserListPage {
  users: PublicUser[];
  total: number;
}

export function listUsers(
  db: Db,
  options: { limit: number; offset: number; search?: string },
): UserListPage {
  const search = options.search?.trim();
  const where = search ? 'WHERE email LIKE ? OR display_name LIKE ?' : '';
  const params = search ? [`%${search}%`, `%${search}%`] : [];

  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM users ${where}`).get(...params) as { count: number }
  ).count;

  const rows = db
    .prepare(`SELECT * FROM users ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`)
    .all(...params, options.limit, options.offset) as UserRow[];

  return { users: rows.map(toPublicUser), total };
}
