import { conflict, forbidden, notFound } from '../errors.js';
import { newId } from '../utils/ids.js';
import type { Db } from './index.js';

export type VaultRole = 'owner' | 'editor' | 'reader';

const ROLE_RANK: Record<VaultRole, number> = {
  reader: 1,
  editor: 2,
  owner: 3,
};

export interface VaultRow {
  id: string;
  owner_id: string;
  name: string;
  e2ee: number;
  revision: number;
  pruned_before_rev: number;
  created_at: number;
  updated_at: number;
}

export interface VaultMemberRow {
  vault_id: string;
  user_id: string;
  role: VaultRole;
  key_envelope: string | null;
  created_at: number;
}

export interface VaultAccess {
  vault: VaultRow;
  membership: VaultMemberRow;
}

export interface VaultListItem extends VaultRow {
  role: VaultRole;
  key_envelope: string | null;
  joined_at: number;
  member_count: number;
}

export interface MemberListItem extends VaultMemberRow {
  email: string;
  display_name: string | null;
}

export function hasRole(actual: VaultRole, required: VaultRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function createVault(
  db: Db,
  input: { id?: string; ownerId: string; name: string; e2ee: boolean; keyEnvelope?: string | null },
): VaultRow {
  const now = Date.now();
  const vault: VaultRow = {
    id: input.id ?? newId(),
    owner_id: input.ownerId,
    name: input.name,
    e2ee: input.e2ee ? 1 : 0,
    revision: 0,
    pruned_before_rev: 0,
    created_at: now,
    updated_at: now,
  };

  const run = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM vaults WHERE id = ?').get(vault.id)) {
      throw conflict('VAULT_EXISTS', 'A vault with this id already exists');
    }
    db.prepare(
      `INSERT INTO vaults (id, owner_id, name, e2ee, revision, pruned_before_rev, created_at, updated_at)
       VALUES (@id, @owner_id, @name, @e2ee, @revision, @pruned_before_rev, @created_at, @updated_at)`,
    ).run(vault);
    db.prepare(
      `INSERT INTO vault_members (vault_id, user_id, role, key_envelope, created_at)
       VALUES (?, ?, 'owner', ?, ?)`,
    ).run(vault.id, input.ownerId, input.keyEnvelope ?? null, now);
  });

  run();
  return vault;
}

export function getVault(db: Db, vaultId: string): VaultRow | undefined {
  return db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId) as VaultRow | undefined;
}

export function getMembership(db: Db, vaultId: string, userId: string): VaultMemberRow | undefined {
  return db
    .prepare('SELECT * FROM vault_members WHERE vault_id = ? AND user_id = ?')
    .get(vaultId, userId) as VaultMemberRow | undefined;
}

export function requireVaultAccess(
  db: Db,
  vaultId: string,
  userId: string,
  minimumRole: VaultRole = 'reader',
): VaultAccess {
  const vault = getVault(db, vaultId);
  const membership = vault ? getMembership(db, vaultId, userId) : undefined;

  if (!vault || !membership) {
    throw notFound('VAULT_NOT_FOUND', 'Vault not found');
  }

  if (!hasRole(membership.role, minimumRole)) {
    throw forbidden('INSUFFICIENT_ROLE', `This action requires the ${minimumRole} role`);
  }

  return { vault, membership };
}

export function listVaultsForUser(db: Db, userId: string): VaultListItem[] {
  return db
    .prepare(
      `SELECT v.*, m.role, m.key_envelope, m.created_at AS joined_at,
         (SELECT COUNT(*) FROM vault_members vm WHERE vm.vault_id = v.id) AS member_count
       FROM vaults v
       JOIN vault_members m ON m.vault_id = v.id
       WHERE m.user_id = ?
       ORDER BY v.updated_at DESC`,
    )
    .all(userId) as VaultListItem[];
}

export function updateVaultName(db: Db, vaultId: string, name: string): VaultRow {
  db.prepare('UPDATE vaults SET name = ?, updated_at = ? WHERE id = ?').run(
    name,
    Date.now(),
    vaultId,
  );
  const vault = getVault(db, vaultId);
  if (!vault) throw notFound('VAULT_NOT_FOUND', 'Vault not found');
  return vault;
}

export function deleteVault(db: Db, vaultId: string): void {
  db.prepare('DELETE FROM vaults WHERE id = ?').run(vaultId);
}

export function listMembers(db: Db, vaultId: string): MemberListItem[] {
  return db
    .prepare(
      `SELECT m.*, u.email, u.display_name
       FROM vault_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.vault_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.email`,
    )
    .all(vaultId) as MemberListItem[];
}

export function addMember(
  db: Db,
  input: {
    vaultId: string;
    userId: string;
    role: Exclude<VaultRole, 'owner'>;
    keyEnvelope?: string | null;
  },
): VaultMemberRow {
  if (getMembership(db, input.vaultId, input.userId)) {
    throw conflict('MEMBER_EXISTS', 'This user is already a member of the vault');
  }

  const member: VaultMemberRow = {
    vault_id: input.vaultId,
    user_id: input.userId,
    role: input.role,
    key_envelope: input.keyEnvelope ?? null,
    created_at: Date.now(),
  };

  db.prepare(
    'INSERT INTO vault_members (vault_id, user_id, role, key_envelope, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(member.vault_id, member.user_id, member.role, member.key_envelope, member.created_at);

  return member;
}

export function setMemberRole(
  db: Db,
  vaultId: string,
  userId: string,
  role: Exclude<VaultRole, 'owner'>,
): VaultMemberRow {
  const member = getMembership(db, vaultId, userId);
  if (!member) throw notFound('MEMBER_NOT_FOUND', 'Vault member not found');
  if (member.role === 'owner')
    throw conflict('CANNOT_CHANGE_OWNER', 'The vault owner role cannot be changed');
  db.prepare('UPDATE vault_members SET role = ? WHERE vault_id = ? AND user_id = ?').run(
    role,
    vaultId,
    userId,
  );
  return { ...member, role };
}

export function setMemberKeyEnvelope(
  db: Db,
  vaultId: string,
  userId: string,
  keyEnvelope: string | null,
): VaultMemberRow {
  const member = getMembership(db, vaultId, userId);
  if (!member) throw notFound('MEMBER_NOT_FOUND', 'Vault member not found');
  db.prepare('UPDATE vault_members SET key_envelope = ? WHERE vault_id = ? AND user_id = ?').run(
    keyEnvelope,
    vaultId,
    userId,
  );
  return { ...member, key_envelope: keyEnvelope };
}

export function removeMember(db: Db, vaultId: string, userId: string): void {
  const member = getMembership(db, vaultId, userId);
  if (!member) throw notFound('MEMBER_NOT_FOUND', 'Vault member not found');
  if (member.role === 'owner')
    throw conflict('CANNOT_REMOVE_OWNER', 'The vault owner cannot be removed');
  db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?').run(vaultId, userId);
}

export function memberCount(db: Db, vaultId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM vault_members WHERE vault_id = ?').get(vaultId) as {
      count: number;
    }
  ).count;
}

export function countVaults(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM vaults').get() as { count: number }).count;
}
