/**
 * Task 7.001: the real git/npm/vite wiring behind `webOnlyUpdateRunner.ts`'s `WebOnlyUpdateSteps` —
 * kept out of that module so its orchestration stays pure and fake-injectable for tests (see its own
 * doc comment). Used only by `appUpdateService.ts`'s web-only apply path.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pullFastForward } from './updateGitSteps.ts';
import { APP_CHECKOUT_ROOT } from '../config.ts';
import type { WebOnlyUpdateSteps } from './webOnlyUpdateRunner.ts';

const exec = promisify(execFile);

async function runNpm(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await exec('npm', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string };
    const combined = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    return { ok: false, output: combined || failure.message };
  }
}

/**
 * `--include=dev` is load-bearing: the daemon runs with `NODE_ENV=production` (scripts/prod-start.sh)
 * and npm inherits it, which would otherwise omit — and prune — the devDependencies `npm run build`
 * needs (`tsc`, the vite plugins), breaking this build and every later `prod:start`.
 */
export function webInstallArgs(webDir: string): string[] {
  return ['install', '--include=dev', '--prefix', webDir];
}

export const realWebOnlySteps: WebOnlyUpdateSteps = {
  pull: () => pullFastForward(APP_CHECKOUT_ROOT),

  async installWeb() {
    return runNpm(webInstallArgs(path.join(APP_CHECKOUT_ROOT, 'web')), APP_CHECKOUT_ROOT);
  },

  /**
   * Builds into `web/dist.new/` and only swaps it over `web/dist/` once the build has fully
   * succeeded — the invariant this whole path exists to uphold: a build failure must leave the
   * previously-served build intact, since the daemon and the already-running `vite preview` static
   * server are never stopped on this path. `--outDir dist.new` after `--` is what `npm run build`
   * (`tsc -b && vite build`) forwards straight to `vite build`, which accepts it as-is.
   */
  async buildWeb() {
    const webDir = path.join(APP_CHECKOUT_ROOT, 'web');
    const stagingDir = path.join(webDir, 'dist.new');
    const result = await runNpm(['run', 'build', '--prefix', webDir, '--', '--outDir', 'dist.new'], APP_CHECKOUT_ROOT);
    if (!result.ok) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return result;
    }
    await rm(path.join(webDir, 'dist'), { recursive: true, force: true }).catch(() => {});
    await rename(stagingDir, path.join(webDir, 'dist'));
    return result;
  },
};
