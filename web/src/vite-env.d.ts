/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the agent-visual-os daemon (server/). Defaults to http://localhost:4500 when unset. */
  readonly VITE_SERVER_URL?: string;
}

/**
 * This bundle's own short git commit sha, baked in by `vite.config.ts` at build time. Compared
 * against the live `AppUpdateStatus.currentCommit` the store tracks, this is what drives the reload
 * banner — see `lib/appUpdate.ts`'s `nextReloadBannerVisibility`.
 */
declare const __APP_BUILD_COMMIT__: string;
