import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { revokeAllForUser } from '../db/tokens.js';
import {
  bumpTokenVersion,
  createUser,
  findUserByEmail,
  updateUserFlags,
  updateUserPassword,
  userCount,
} from '../db/users.js';
import { hashPassword, verifyPassword } from './password.js';

export interface BootstrapResult {
  created: boolean;
  passwordUpdated: boolean;
}

export async function ensureConfiguredUser(
  db: Db,
  config: Config,
): Promise<BootstrapResult | null> {
  const configured = config.configuredUser;
  if (!configured) return null;

  const existing = findUserByEmail(db, configured.email);

  if (!existing) {
    const passwordHash = await hashPassword(configured.password);
    createUser(db, {
      email: configured.email,
      passwordHash,
      displayName: configured.name,
      isAdmin: true,
    });
    return { created: true, passwordUpdated: false };
  }

  let passwordUpdated = false;
  if (!(await verifyPassword(configured.password, existing.password_hash))) {
    const passwordHash = await hashPassword(configured.password);
    updateUserPassword(db, existing.id, passwordHash);
    revokeAllForUser(db, existing.id);
    bumpTokenVersion(db, existing.id);
    passwordUpdated = true;
  }

  if (existing.is_admin !== 1 || existing.disabled === 1) {
    updateUserFlags(db, existing.id, { isAdmin: true, disabled: false });
  }

  return { created: false, passwordUpdated };
}

export function needsFirstRunSetup(db: Db, config: Config): boolean {
  return userCount(db) === 0 && config.configuredUser === null;
}
