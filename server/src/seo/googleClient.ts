import { appSecrets, SecretsStore } from '../buildings/secrets.ts';
import { projectsDb } from '../db/collections.ts';
import { SeoInputError } from './errors.ts';

/**
 * The person's own Google Cloud OAuth client, one for the whole app: every SEO Building signs in to Search Console,
 * Analytics and Ads with it. Both values are write-only: nothing ever reads them back to the browser.
 */

const KEYS = { clientId: 'google.clientId', clientSecret: 'google.clientSecret' } as const;

export interface GoogleClient { clientId: string; clientSecret: string }

const pairOf = async (store: SecretsStore): Promise<GoogleClient | undefined> => {
  const [clientId, clientSecret] = await Promise.all([store.get(KEYS.clientId), store.get(KEYS.clientSecret)]);
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
};

/** The saved client, or undefined until both values are saved. */
export const readGoogleClient = (): Promise<GoogleClient | undefined> => pairOf(appSecrets());

export const googleClientSaved = async (): Promise<boolean> => (await readGoogleClient()) !== undefined;

/** Saves both values in one write (trimmed); refuses anything but two non-empty strings and keeps the old pair then. */
export async function saveGoogleClient(clientId: unknown, clientSecret: unknown): Promise<void> {
  if (typeof clientId !== 'string' || !clientId.trim() || typeof clientSecret !== 'string' || !clientSecret.trim()) throw new SeoInputError('clientId and clientSecret are required');
  await appSecrets().setMany({ [KEYS.clientId]: clientId.trim(), [KEYS.clientSecret]: clientSecret.trim() });
}

/** Forgets the client. Existing connections stay; their next refresh asks the person to connect again. */
export const clearGoogleClient = (): Promise<void> => appSecrets().delete(KEYS.clientId, KEYS.clientSecret);

/**
 * Moves the client that SEO Buildings used to keep in their own secrets into the app-wide store. When none is saved
 * yet, the oldest Building's full pair becomes the app's; then every SEO Building's own client id and secret is
 * deleted, whether it matched or not, because only the app-wide client is used from now on. Safe to repeat.
 */
export async function migrateGoogleClients(): Promise<void> {
  const buildings = (await projectsDb.find((p) => p.typeId === 'seo'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  let needsSource = !(await googleClientSaved());
  for (const building of buildings) {
    try {
      const store = new SecretsStore(building.id);
      if (needsSource) {
        const pair = await pairOf(store);
        if (pair) {
          await saveGoogleClient(pair.clientId, pair.clientSecret);
          needsSource = false;
          console.log(`Moved the Google client of SEO Building ${building.id} into Settings > Google (SEO).`);
        }
      }
      await store.delete(KEYS.clientId, KEYS.clientSecret);
    } catch (error) {
      // Only the error's code: a JSON parse message can quote the file's contents.
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
      console.error(`Could not move the Google client of SEO Building ${building.id} (${code}).`);
    }
  }
}
