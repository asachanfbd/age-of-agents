import { defaultExecutorDb } from '../db/collections.ts';
import { raiseNotification, resolveNotifications } from '../notifications/notificationService.ts';
import { getExecutorLimits } from './claudeUsage.ts';
import { DefaultExecutorService, type DefaultExecutorStore } from './defaultExecutor.ts';
import { listExecutors } from './executorService.ts';

export const defaultExecutorStore: DefaultExecutorStore = {
  get: () => defaultExecutorDb.get('default'),
  async set(value) {
    if (await defaultExecutorDb.get('default')) await defaultExecutorDb.update('default', value);
    else await defaultExecutorDb.insert({ id: 'default', ...value });
  },
  async clear() { await defaultExecutorDb.delete('default'); },
};

/** The daemon's own default-agent service. */
export const defaultExecutor = new DefaultExecutorService({
  listExecutors,
  readLimits: getExecutorLimits,
  store: defaultExecutorStore,
  raise: raiseNotification,
  resolve: resolveNotifications,
});
