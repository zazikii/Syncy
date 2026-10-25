import { conflict, notFound } from '../errors.js';
import { isDeviceId, newId } from '../utils/ids.js';
import type { Db } from './index.js';

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  platform: string | null;
  created_at: number;
  last_seen_at: number;
}

export interface DeviceInput {
  id?: string;
  name?: string;
  platform?: string;
}

export interface PublicDevice {
  id: string;
  name: string;
  platform: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export function toPublicDevice(device: DeviceRow): PublicDevice {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at,
  };
}

export function upsertDevice(db: Db, userId: string, input: DeviceInput = {}): DeviceRow {
  if (input.id !== undefined && !isDeviceId(input.id)) {
    throw new Error('Invalid device id');
  }

  const now = Date.now();
  const id = input.id ?? newId();
  const name = (input.name ?? 'Unknown device').trim().slice(0, 120) || 'Unknown device';
  const platform = input.platform?.trim().slice(0, 60) ?? null;

  const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as
    | DeviceRow
    | undefined;
  if (existing) {
    if (existing.user_id !== userId) {
      throw conflict('DEVICE_EXISTS', 'This device id belongs to another account');
    }
    db.prepare('UPDATE devices SET name = ?, platform = ?, last_seen_at = ? WHERE id = ?').run(
      name,
      platform,
      now,
      id,
    );
    return { ...existing, name, platform, last_seen_at: now };
  }

  const device: DeviceRow = {
    id,
    user_id: userId,
    name,
    platform,
    created_at: now,
    last_seen_at: now,
  };
  db.prepare(
    'INSERT INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    device.id,
    device.user_id,
    device.name,
    device.platform,
    device.created_at,
    device.last_seen_at,
  );

  return device;
}

export function touchDevice(db: Db, userId: string, deviceId: string | null | undefined): void {
  if (!deviceId) return;
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND user_id = ?').run(
    Date.now(),
    deviceId,
    userId,
  );
}

export function listDevices(db: Db, userId: string): DeviceRow[] {
  return db
    .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC')
    .all(userId) as DeviceRow[];
}

export function getDevice(db: Db, userId: string, deviceId: string): DeviceRow | undefined {
  return db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(deviceId, userId) as
    | DeviceRow
    | undefined;
}

export function renameDevice(db: Db, userId: string, deviceId: string, name: string): DeviceRow {
  const device = getDevice(db, userId, deviceId);
  if (!device) throw notFound('DEVICE_NOT_FOUND', 'Device not found');
  const trimmed = name.trim().slice(0, 120) || 'Unknown device';
  db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(trimmed, deviceId);
  return { ...device, name: trimmed };
}

export function deleteDevice(db: Db, userId: string, deviceId: string): void {
  const device = getDevice(db, userId, deviceId);
  if (!device) throw notFound('DEVICE_NOT_FOUND', 'Device not found');
  db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
}
