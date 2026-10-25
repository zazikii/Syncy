import type { FastifyInstance } from 'fastify';
import { findUserByEmail } from '../db/users.js';
import {
  addMember,
  createVault,
  deleteVault,
  listMembers,
  listVaultsForUser,
  type MemberListItem,
  memberCount,
  removeMember,
  requireVaultAccess,
  setMemberKeyEnvelope,
  setMemberRole,
  updateVaultName,
  type VaultAccess,
  type VaultListItem,
  type VaultRow,
} from '../db/vaults.js';
import { conflict, forbidden, notFound } from '../errors.js';
import {
  addMemberSchema,
  createVaultSchema,
  memberParams,
  updateMemberSchema,
  updateVaultSchema,
  vaultParams,
} from './schemas.js';

function vaultView(vault: VaultRow, role: string, keyEnvelope: string | null, members: number) {
  return {
    id: vault.id,
    name: vault.name,
    e2ee: vault.e2ee === 1,
    revision: vault.revision,
    prunedBeforeRevision: vault.pruned_before_rev,
    role,
    ownerId: vault.owner_id,
    keyEnvelope,
    memberCount: members,
    createdAt: vault.created_at,
    updatedAt: vault.updated_at,
  };
}

function vaultListView(vault: VaultListItem) {
  return vaultView(vault, vault.role, vault.key_envelope, vault.member_count);
}

function memberView(member: MemberListItem, includeEnvelope: boolean) {
  return {
    userId: member.user_id,
    email: member.email,
    displayName: member.display_name,
    role: member.role,
    hasKeyEnvelope: member.key_envelope !== null,
    ...(includeEnvelope ? { keyEnvelope: member.key_envelope } : {}),
    createdAt: member.created_at,
  };
}

function accessView(access: VaultAccess, members: number) {
  return vaultView(access.vault, access.membership.role, access.membership.key_envelope, members);
}

export async function registerVaultRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/vaults', { preHandler: app.authenticate }, async (request, reply) => {
    const body = createVaultSchema.parse(request.body);
    const vault = createVault(app.db, {
      id: body.id,
      ownerId: request.auth!.user.id,
      name: body.name,
      e2ee: body.e2ee ?? false,
      keyEnvelope: body.keyEnvelope ?? null,
    });

    const view = vaultView(vault, 'owner', body.keyEnvelope ?? null, 1);
    return reply.status(201).send({ vault: view });
  });

  app.get('/v1/vaults', { preHandler: app.authenticate }, async (request) => {
    const vaults = listVaultsForUser(app.db, request.auth!.user.id);
    return { vaults: vaults.map(vaultListView) };
  });

  app.get('/v1/vaults/:vaultId', { preHandler: app.authenticate }, async (request) => {
    const { vaultId } = vaultParams.parse(request.params);
    const access = requireVaultAccess(app.db, vaultId, request.auth!.user.id);
    return { vault: accessView(access, memberCount(app.db, vaultId)) };
  });

  app.patch('/v1/vaults/:vaultId', { preHandler: app.authenticate }, async (request) => {
    const { vaultId } = vaultParams.parse(request.params);
    const body = updateVaultSchema.parse(request.body);
    const access = requireVaultAccess(app.db, vaultId, request.auth!.user.id, 'owner');
    const vault = updateVaultName(app.db, vaultId, body.name);
    return {
      vault: vaultView(
        vault,
        access.membership.role,
        access.membership.key_envelope,
        memberCount(app.db, vaultId),
      ),
    };
  });

  app.delete('/v1/vaults/:vaultId', { preHandler: app.authenticate }, async (request, reply) => {
    const { vaultId } = vaultParams.parse(request.params);
    requireVaultAccess(app.db, vaultId, request.auth!.user.id, 'owner');
    deleteVault(app.db, vaultId);
    app.hub.broadcastVault(vaultId, {
      type: 'vault_deleted',
      vaultId,
      actorUserId: request.auth!.user.id,
    });
    app.hub.dropVault(vaultId);
    return reply.status(204).send();
  });

  app.get('/v1/vaults/:vaultId/members', { preHandler: app.authenticate }, async (request) => {
    const { vaultId } = vaultParams.parse(request.params);
    const access = requireVaultAccess(app.db, vaultId, request.auth!.user.id);
    const members = listMembers(app.db, vaultId);
    return {
      members: members.map((member) =>
        memberView(
          member,
          access.membership.role === 'owner' || member.user_id === request.auth!.user.id,
        ),
      ),
    };
  });

  app.post(
    '/v1/vaults/:vaultId/members',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { vaultId } = vaultParams.parse(request.params);
      requireVaultAccess(app.db, vaultId, request.auth!.user.id, 'owner');
      const body = addMemberSchema.parse(request.body);
      const user = findUserByEmail(app.db, body.email);
      if (!user) throw notFound('USER_NOT_FOUND', 'No account with this email exists');

      const member = addMember(app.db, {
        vaultId,
        userId: user.id,
        role: body.role,
        keyEnvelope: body.keyEnvelope ?? null,
      });

      app.hub.broadcastVault(vaultId, {
        type: 'vault_members_changed',
        vaultId,
        actorUserId: request.auth!.user.id,
      });

      return reply.status(201).send({
        member: memberView(
          {
            ...member,
            email: user.email,
            display_name: user.display_name,
          },
          true,
        ),
      });
    },
  );

  app.patch(
    '/v1/vaults/:vaultId/members/:userId',
    { preHandler: app.authenticate },
    async (request) => {
      const { vaultId, userId } = memberParams.parse(request.params);
      const access = requireVaultAccess(app.db, vaultId, request.auth!.user.id);
      const body = updateMemberSchema.parse(request.body);
      const isOwner = access.membership.role === 'owner';
      const isSelf = request.auth!.user.id === userId;

      if (body.role !== undefined && !isOwner) {
        throw forbidden('INSUFFICIENT_ROLE', 'Only the vault owner can change member roles');
      }
      if (body.keyEnvelope !== undefined && !isOwner && !isSelf) {
        throw forbidden('INSUFFICIENT_ROLE', 'You can only update your own key envelope');
      }

      if (body.role !== undefined) {
        setMemberRole(app.db, vaultId, userId, body.role);
      }
      if (body.keyEnvelope !== undefined) {
        setMemberKeyEnvelope(app.db, vaultId, userId, body.keyEnvelope);
      }

      const members = listMembers(app.db, vaultId);
      const member = members.find((item) => item.user_id === userId);
      if (!member) throw notFound('MEMBER_NOT_FOUND', 'Vault member not found');

      app.hub.broadcastVault(vaultId, {
        type: 'vault_members_changed',
        vaultId,
        actorUserId: request.auth!.user.id,
      });

      return { member: memberView(member, isOwner || isSelf) };
    },
  );

  app.delete(
    '/v1/vaults/:vaultId/members/:userId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { vaultId, userId } = memberParams.parse(request.params);
      const access = requireVaultAccess(app.db, vaultId, request.auth!.user.id);
      const isOwner = access.membership.role === 'owner';
      const isSelf = request.auth!.user.id === userId;

      if (!isOwner && !isSelf) {
        throw forbidden('INSUFFICIENT_ROLE', 'Only the vault owner can remove other members');
      }
      if (isSelf && access.membership.role === 'owner') {
        throw conflict('OWNER_CANNOT_LEAVE', 'Transfer or delete the vault instead');
      }

      removeMember(app.db, vaultId, userId);
      app.hub.dropVaultMember(vaultId, userId);
      app.hub.broadcastVault(vaultId, {
        type: 'vault_members_changed',
        vaultId,
        actorUserId: request.auth!.user.id,
      });
      return reply.status(204).send();
    },
  );
}
