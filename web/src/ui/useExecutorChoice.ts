import { useState } from 'react';
import { resolveExecutorChoice, retainedChoice } from '../lib/executorAvailability';
import { useWorldStore } from '../store/worldStore';
import { useNow } from './useNow';

/**
 * The coding agent a surface will use, following the app-wide default until the person picks another.
 * A pick applies to that surface's one start or send only; it never changes the default. A pick that
 * stops being usable falls back to the preselection and is not restored when the agent frees up again.
 */
export function useExecutorChoice() {
  const executors = useWorldStore((s) => s.executors);
  const now = useNow();
  const [touched, setTouched] = useState('');
  const executorId = resolveExecutorChoice(executors, touched, now);
  if (retainedChoice(executors, touched, now) !== touched) setTouched('');
  return { executors, executorId, choose: setTouched };
}
