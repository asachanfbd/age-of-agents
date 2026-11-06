import { useWorldStore } from '../src/store/worldStore.ts';

/** The message of the latest error notification, or null — what a user sees for a failure that wasn't tied to an open form. */
export function reportedError() {
  const entries = Object.values(useWorldStore.getState().errorNotificationsById);
  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return entries[0]?.description ?? null;
}

/** State fields to spread into a store reset so no error notification or open form leaks between tests. */
export const CLEAN_ERROR_STATE = { errorNotificationsById: {}, errorNotificationSeq: 0, openErrorScopes: {}, formErrors: {} };
