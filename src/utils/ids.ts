import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export const FILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isFileId(value: string): boolean {
  return FILE_ID_PATTERN.test(value);
}

export function isDeviceId(value: string): boolean {
  return DEVICE_ID_PATTERN.test(value);
}
