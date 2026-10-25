import { conflict } from '../errors.js';
import type { Db } from './index.js';

export interface VaultSettingsRow {
  vault_id: string;
  revision: number;
  data: string;
  updated_at: number;
  updated_by_device: string | null;
}

export interface VaultSettingsView {
  vaultId: string;
  revision: number;
  settings: Record<string, unknown> | null;
  updatedAt: number | null;
  updatedByDevice: string | null;
}

export function toVaultSettingsView(
  vaultId: string,
  row: VaultSettingsRow | undefined,
): VaultSettingsView {
  if (!row) {
    return {
      vaultId,
      revision: 0,
      settings: null,
      updatedAt: null,
      updatedByDevice: null,
    };
  }

  return {
    vaultId,
    revision: row.revision,
    settings: JSON.parse(row.data) as Record<string, unknown>,
    updatedAt: row.updated_at,
    updatedByDevice: row.updated_by_device,
  };
}

export function getVaultSettings(db: Db, vaultId: string): VaultSettingsRow | undefined {
  return db.prepare('SELECT * FROM vault_settings WHERE vault_id = ?').get(vaultId) as
    | VaultSettingsRow
    | undefined;
}

export function saveVaultSettings(
  db: Db,
  input: {
    vaultId: string;
    settings: Record<string, unknown>;
    expectedRevision?: number | null;
    deviceId: string | null;
  },
): VaultSettingsRow {
  const run = db.transaction((): VaultSettingsRow => {
    const current = getVaultSettings(db, input.vaultId);
    const currentRevision = current?.revision ?? 0;

    if (input.expectedRevision !== undefined) {
      const matches =
        input.expectedRevision === null
          ? currentRevision === 0
          : currentRevision === input.expectedRevision;

      if (!matches) {
        throw conflict(
          'SETTINGS_CONFLICT',
          'Vault settings have changed on the server since the expected revision',
          {
            currentRevision,
            settings: current ? (JSON.parse(current.data) as unknown) : null,
            updatedAt: current?.updated_at ?? null,
            updatedByDevice: current?.updated_by_device ?? null,
          },
        );
      }
    }

    const now = Date.now();
    const row: VaultSettingsRow = {
      vault_id: input.vaultId,
      revision: currentRevision + 1,
      data: JSON.stringify(input.settings),
      updated_at: now,
      updated_by_device: input.deviceId,
    };

    db.prepare(
      `INSERT INTO vault_settings (vault_id, revision, data, updated_at, updated_by_device)
       VALUES (@vault_id, @revision, @data, @updated_at, @updated_by_device)
       ON CONFLICT(vault_id) DO UPDATE SET
         revision = excluded.revision,
         data = excluded.data,
         updated_at = excluded.updated_at,
         updated_by_device = excluded.updated_by_device`,
    ).run(row);

    return row;
  });

  return run.immediate();
}
