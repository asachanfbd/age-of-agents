export const DEFAULT_WARNING_BYTES = 2 * 1024 ** 3;

export function validateThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new RangeError('warningBytes must be a positive number');
  return Math.floor(value);
}

export type StorageLevel = 'ok' | 'warning';

/** `warning` at or above the threshold (exactly at it included). */
export function storageLevel(bytes: number, threshold: number = DEFAULT_WARNING_BYTES): StorageLevel {
  return bytes >= threshold ? 'warning' : 'ok';
}
