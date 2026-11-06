export const LOCAL_USER_ID = 'local-user';
export const LOCAL_TENANT_ID = 'local-tenant';

export interface Ownership { ownerId: string; tenantId: string }

/** Stamps a record about to be stored with its owner and tenant, keeping any explicit values. */
export function withOwnership<T extends object>(record: T): T & Ownership {
  const { ownerId, tenantId } = record as { ownerId?: string; tenantId?: string };
  return { ...record, ownerId: ownerId ?? LOCAL_USER_ID, tenantId: tenantId ?? LOCAL_TENANT_ID };
}

/** The owner/tenant a stored record reads as; records written before these fields existed are the local user's. Does not rewrite the record. */
export function ownershipOf(record: { ownerId?: string; tenantId?: string }): Ownership {
  return { ownerId: record.ownerId ?? LOCAL_USER_ID, tenantId: record.tenantId ?? LOCAL_TENANT_ID };
}
