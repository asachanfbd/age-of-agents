import type { Db } from './db.ts';

export interface ContentCtx {
  db: Db;
  buildingId: string;
  /** `<data>/buildings/<id>/`, the folder agents are pointed at. */
  dir: string;
  now(): number;
  timezone(): string;
  /** Runs async work one at a time per Building. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}
