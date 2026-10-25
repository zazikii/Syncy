import type { FastifyInstance } from 'fastify';
import { touchDevice } from '../db/devices.js';
import {
  getFile,
  getVersion,
  listAllFiles,
  listChanges,
  listVersions,
  toChange,
  toFileSummary,
  toVersion,
} from '../db/sync.js';
import { requireVaultAccess } from '../db/vaults.js';
import { badRequest, gone, notFound } from '../errors.js';
import { applyChanges, type ChangeInput } from '../services/sync.js';
import {
  changesQuery,
  fileParams,
  filesQuery,
  pushChangesSchema,
  restoreVersionSchema,
  vaultParams,
  versionParams,
  versionsQuery,
} from './schemas.js';

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/vaults/:vaultId/files', { preHandler: app.authenticate }, async (request) => {
    const { vaultId } = vaultParams.parse(request.params);
    const query = filesQuery.parse(request.query);
    const access = requireVaultAccess(app.db, vaultId, request.auth!.user.id);
    const files = listAllFiles(app.db, vaultId, query.includeDeleted);

    return {
      vaultId,
      revision: access.vault.revision,
      prunedBeforeRevision: access.vault.pruned_before_rev,
      files: files.map(toFileSummary),
    };
  });

  app.get('/v1/vaults/:vaultId/changes', { preHandler: app.authenticate }, async (request) => {
    const { vaultId } = vaultParams.parse(request.params);
    const query = changesQuery.parse(request.query);
    const access = requireVaultAccess(app.db, vaultId, request.auth!.user.id);
    const currentRevision = access.vault.revision;

    if (query.since > currentRevision) {
      throw gone('CURSOR_AHEAD', 'The server revision is behind this cursor; run a full resync', {
        revision: currentRevision,
        prunedBeforeRevision: access.vault.pruned_before_rev,
      });
    }

    if (query.since < access.vault.pruned_before_rev) {
      throw gone(
        'CURSOR_EXPIRED',
        'Change history for this cursor has been pruned; run a full resync',
        {
          revision: currentRevision,
          prunedBeforeRevision: access.vault.pruned_before_rev,
        },
      );
    }

    const until = Math.min(query.until ?? currentRevision, currentRevision);
    const rows = listChanges(app.db, vaultId, query.since, until, query.limit + 1);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = page.length > 0 ? page[page.length - 1]!.revision : query.since;

    return {
      vaultId,
      since: query.since,
      until,
      revision: currentRevision,
      prunedBeforeRevision: access.vault.pruned_before_rev,
      hasMore,
      nextCursor,
      changes: page.map(toChange),
    };
  });

  app.post(
    '/v1/vaults/:vaultId/changes',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { vaultId } = vaultParams.parse(request.params);
      requireVaultAccess(app.db, vaultId, request.auth!.user.id, 'editor');
      const body = pushChangesSchema.parse(request.body);
      const atomic = body.atomic ?? true;

      const result = await applyChanges(app.db, app.blobs, {
        vaultId,
        deviceId: request.auth!.deviceId,
        changes: body.changes as ChangeInput[],
        atomic,
      });

      touchDevice(app.db, request.auth!.user.id, request.auth!.deviceId);

      if (result.applied) {
        app.hub.broadcastVault(vaultId, {
          type: 'vault_changed',
          vaultId,
          revision: result.revision,
          actorUserId: request.auth!.user.id,
          originDeviceId: request.auth!.deviceId,
        });
      }

      const statusCode = atomic && result.hasConflicts ? 409 : 200;
      return reply.status(statusCode).send(result);
    },
  );

  app.get(
    '/v1/vaults/:vaultId/files/:fileId/versions',
    { preHandler: app.authenticate },
    async (request) => {
      const { vaultId, fileId } = fileParams.parse(request.params);
      const query = versionsQuery.parse(request.query);
      requireVaultAccess(app.db, vaultId, request.auth!.user.id);

      const file = getFile(app.db, vaultId, fileId);
      if (!file) throw notFound('FILE_NOT_FOUND', 'File not found');

      const rows = listVersions(app.db, vaultId, fileId, query.cursor ?? null, query.limit + 1);
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]!.revision : null;

      return {
        vaultId,
        fileId,
        hasMore,
        nextCursor,
        versions: page.map(toVersion),
      };
    },
  );

  app.get(
    '/v1/vaults/:vaultId/files/:fileId/versions/:versionId',
    { preHandler: app.authenticate },
    async (request) => {
      const { vaultId, fileId, versionId } = versionParams.parse(request.params);
      requireVaultAccess(app.db, vaultId, request.auth!.user.id);
      const version = getVersion(app.db, vaultId, fileId, versionId);
      if (!version) throw notFound('VERSION_NOT_FOUND', 'Version not found');
      return { version: toVersion(version) };
    },
  );

  app.post(
    '/v1/vaults/:vaultId/files/:fileId/versions/:versionId/restore',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { vaultId, fileId, versionId } = versionParams.parse(request.params);
      requireVaultAccess(app.db, vaultId, request.auth!.user.id, 'editor');
      const body = restoreVersionSchema.parse(request.body ?? {});
      const version = getVersion(app.db, vaultId, fileId, versionId);
      if (!version) throw notFound('VERSION_NOT_FOUND', 'Version not found');
      if (version.deleted === 1) {
        throw badRequest('DELETED_VERSION', 'A deleted version cannot be restored');
      }
      if (version.kind === 'file' && !version.hash) {
        throw badRequest('EMPTY_VERSION', 'This version has no stored content');
      }

      const current = getFile(app.db, vaultId, fileId);
      const path = body.path ?? (current && current.deleted === 0 ? current.path : version.path);
      const expectedRevision =
        body.expectedRevision === undefined ? (current?.rev ?? null) : body.expectedRevision;

      const result = await applyChanges(app.db, app.blobs, {
        vaultId,
        deviceId: request.auth!.deviceId,
        changes: [
          {
            fileId,
            path,
            kind: version.kind,
            encrypted: version.encrypted === 1,
            hash: version.hash,
            size: version.size,
            mtime: version.mtime,
            ctime: version.ctime,
            deleted: false,
            expectedRevision,
          },
        ],
        atomic: true,
      });

      if (result.applied) {
        app.hub.broadcastVault(vaultId, {
          type: 'vault_changed',
          vaultId,
          revision: result.revision,
          actorUserId: request.auth!.user.id,
          originDeviceId: request.auth!.deviceId,
        });
      }

      return reply.status(result.hasConflicts ? 409 : 200).send(result);
    },
  );
}
