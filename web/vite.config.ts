import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * This bundle's own short commit sha, baked in as `__APP_BUILD_COMMIT__` (declared in
 * `src/vite-env.d.ts`). Compared at runtime against the daemon's live `AppUpdateStatus.currentCommit`,
 * it's what tells an open tab its own build is stale — see `lib/appUpdate.ts`'s
 * `nextReloadBannerVisibility`. Falls back to 'unknown' so a build outside a git checkout doesn't fail.
 */
function buildCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: fileURLToPath(new URL('.', import.meta.url)) }).toString().trim();
  } catch {
    return 'unknown';
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    __APP_BUILD_COMMIT__: JSON.stringify(buildCommit()),
  },
})
