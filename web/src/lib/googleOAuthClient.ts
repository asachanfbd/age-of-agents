/** The app-wide Google OAuth client (global Settings > Google (SEO)) as the SEO Building's Connections screen describes it. */

export const GOOGLE_CLIENT_MISSING = 'Google client not set up yet. Add it in Settings > Google (SEO).';
export const GOOGLE_CLIENT_IN_USE = 'Using the Google client from Settings.';

/** The notice in place of the old per-Building fields; only the missing state offers to open Settings. */
export function googleClientNotice(saved: boolean): { text: string; showOpenSettings: boolean } {
  return saved ? { text: GOOGLE_CLIENT_IN_USE, showOpenSettings: false } : { text: GOOGLE_CLIENT_MISSING, showOpenSettings: true };
}

/** Why a Google Connect or Reconnect button is disabled, or undefined when it is not. */
export function connectDisabledReason(saved: boolean): string | undefined {
  return saved ? undefined : GOOGLE_CLIENT_MISSING;
}

/** Both values must be non-empty after trimming, as the daemon requires. */
export function canSaveGoogleClient(clientId: string, clientSecret: string): boolean {
  return clientId.trim() !== '' && clientSecret.trim() !== '';
}
