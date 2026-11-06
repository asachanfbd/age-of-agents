import { useEffect, useMemo, useRef, useState } from 'react';
import { serverApi } from './serverApi';
import { useHeldList } from './useYardModel';
import { HEALTH_REFRESH_MS, healthAfterTick, healthConfigOf, sameHealthRuns, sameTestHealth, testHealth } from './villageTestHealth';
import type { HealthConfig, HealthRun, TestHealth } from './villageTestHealth';
import { projectRuns } from './villageYard';

/** How many of the Project's most recent runs the wall reads; enough to hold every suite's latest primary result. */
const RECENT_RUNS = 100;

interface Loaded {
  config: HealthConfig | null;
  runs: HealthRun[];
}

/** The Project's suite config and recent runs from the daemon — the store only holds running and unopened-failed runs until the Testing tab loads. */
async function loadHealthSources(projectId: string): Promise<Loaded> {
  const [overview, page] = await Promise.all([serverApi.getTestingOverview(projectId), serverApi.listTestRuns(projectId, RECENT_RUNS)]);
  return { config: healthConfigOf(overview.suites), runs: page.runs };
}

/** Loaded runs, with any newer copy of the same run from the store's live events taking precedence. */
function mergeRuns(loaded: readonly HealthRun[], live: readonly HealthRun[]): HealthRun[] {
  const byId = new Map(loaded.map((run) => [run.id, run]));
  for (const run of live) byId.set(run.id, run);
  return [...byId.values()];
}

/**
 * A Project's test health on its checked-out branch. The daemon is read on mount and whenever the
 * live run list changes (a run finishing); the clock is re-read every few minutes so the wall's
 * intensity follows the last run's age. State changes only when the health itself does, so the
 * on-demand scene redraws only then.
 */
export function useTestHealth(projectId: string, branch: string | null): TestHealth | null {
  const live = useHeldList((state) => projectRuns(state.testRunsById, projectId), sameHealthRuns);
  const [loaded, setLoaded] = useState<Loaded>({ config: null, runs: [] });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    loadHealthSources(projectId).then(
      (sources) => { if (!cancelled) setLoaded(sources); },
      () => { /* no readable results: no wall */ },
    );
    return () => { cancelled = true; };
  }, [projectId, live]);

  const runs = useMemo(() => mergeRuns(loaded.runs, live), [loaded.runs, live]);
  const computed = useMemo(() => testHealth(runs, loaded.config, branch, now), [runs, loaded.config, branch, now]);
  const [health, setHealth] = useState(computed);
  if (!sameTestHealth(health, computed)) setHealth(computed);

  const current = useRef(health);
  current.current = health;
  useEffect(() => {
    const timer = setInterval(() => {
      const at = Date.now();
      if (healthAfterTick(current.current, runs, loaded.config, branch, at)) setNow(at);
    }, HEALTH_REFRESH_MS);
    return () => clearInterval(timer);
  }, [runs, loaded.config, branch]);

  return health;
}
