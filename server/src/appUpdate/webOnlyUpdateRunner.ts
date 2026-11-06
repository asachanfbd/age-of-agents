/**
 * Task 7.001: the web-only update path's orchestration, pure and fully fake-injectable so it can be
 * exercised without ever shelling out — the real git/npm/vite steps live in `realWebOnlySteps.ts`
 * instead, wired in by `appUpdateService.ts`. Nothing on this path stops or restarts anything: the
 * daemon and the already-running `vite preview` static server are completely untouched regardless of
 * outcome, success or failure alike — see `buildWeb`'s real-implementation doc comment for how a
 * build failure keeps serving the previous build.
 */

export interface WebOnlyUpdateSteps {
  pull(): Promise<{ ok: boolean; output: string }>;
  installWeb(): Promise<{ ok: boolean; output: string }>;
  /** Builds into a staging directory and only swaps it into place on success — see realWebOnlySteps.ts. */
  buildWeb(): Promise<{ ok: boolean; output: string }>;
}

export interface WebOnlyUpdateResult {
  ok: boolean;
  failureMessage?: string;
}

/** pull → (if installWebDeps) installWeb → buildWeb. Any step failing stops the sequence right there. */
export async function runWebOnlyUpdate(steps: WebOnlyUpdateSteps, opts: { installWebDeps: boolean }): Promise<WebOnlyUpdateResult> {
  const pulled = await steps.pull();
  if (!pulled.ok) return { ok: false, failureMessage: pulled.output || 'git pull failed.' };

  if (opts.installWebDeps) {
    const installed = await steps.installWeb();
    if (!installed.ok) return { ok: false, failureMessage: installed.output || 'npm install (web) failed.' };
  }

  const built = await steps.buildWeb();
  if (!built.ok) return { ok: false, failureMessage: built.output || 'Building the web app failed.' };

  return { ok: true };
}
