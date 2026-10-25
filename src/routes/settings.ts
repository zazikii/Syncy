import type { FastifyInstance } from 'fastify';
import { getVaultSettings, saveVaultSettings, toVaultSettingsView } from '../db/settings.js';
import { requireVaultAccess } from '../db/vaults.js';
import { AppError } from '../errors.js';
import { updateVaultSettingsSchema, vaultParams } from './schemas.js';

const MAX_SETTINGS_BYTES = 1_048_576;

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/vaults/:vaultId/settings', { preHandler: app.authenticate }, async (request) => {
    const { vaultId } = vaultParams.parse(request.params);
    requireVaultAccess(app.db, vaultId, request.auth!.user.id);
    return toVaultSettingsView(vaultId, getVaultSettings(app.db, vaultId));
  });

  app.put('/v1/vaults/:vaultId/settings', { preHandler: app.authenticate }, async (request) => {
    const { vaultId } = vaultParams.parse(request.params);
    requireVaultAccess(app.db, vaultId, request.auth!.user.id, 'editor');
    const body = updateVaultSettingsSchema.parse(request.body);

    if (Buffer.byteLength(JSON.stringify(body.settings)) > MAX_SETTINGS_BYTES) {
      throw new AppError(
        413,
        'SETTINGS_TOO_LARGE',
        `Vault settings must be at most ${MAX_SETTINGS_BYTES} bytes`,
      );
    }

    const row = saveVaultSettings(app.db, {
      vaultId,
      settings: body.settings,
      expectedRevision: body.expectedRevision,
      deviceId: request.auth!.deviceId,
    });

    app.hub.broadcastVault(vaultId, {
      type: 'vault_settings_changed',
      vaultId,
      revision: row.revision,
      actorUserId: request.auth!.user.id,
    });

    return toVaultSettingsView(vaultId, row);
  });
}
