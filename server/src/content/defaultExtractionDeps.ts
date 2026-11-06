import { defaultExecutor } from '../executors/defaultExecutorInstance.ts';
import { getExecutor } from '../executors/executorService.ts';
import type { ExtractionDeps } from './extractions.ts';
import { spawnStatsAgent } from './statsAgent.ts';

interface Lookup {
  currentId(): Promise<string | null>;
  find(id: string): Promise<{ kind: string; label: string; bin: string; env?: Record<string, string> } | undefined>;
}

/** The extraction on top of an agent lookup; the real one reads the default coding agent. */
export function createExtractionDeps(lookup: Lookup): ExtractionDeps {
  return {
    agent: spawnStatsAgent,
    async resolveAgent() {
      const id = await lookup.currentId();
      const executor = id ? await lookup.find(id) : undefined;
      if (!executor) return 'No default coding agent is set';
      // Stored profiles are data: a kind this build cannot run is refused with a reason, as the studio sessions do.
      if (executor.kind !== 'claude-cli' && executor.kind !== 'codex-cli') return `${executor.label} cannot read the stats. Set a Claude or Codex CLI agent as the default coding agent.`;
      return { kind: executor.kind, bin: executor.bin, env: executor.env ?? {} };
    },
  };
}

export const defaultExtractionDeps = createExtractionDeps({ currentId: () => defaultExecutor.current(), find: (id) => getExecutor(id) });
