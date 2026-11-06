import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/serverApi';

export const errorText = (error: unknown): string => (error instanceof ApiError || error instanceof Error ? error.message : 'The request failed');

export interface Loaded<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** Loads one resource; a late answer for an older request is dropped, and `reload` asks again. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const latest = useRef(0);
  const run = useCallback(() => {
    const token = ++latest.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => { if (latest.current === token) setState({ data, error: null, loading: false }); },
      (error) => { if (latest.current === token) setState((s) => ({ ...s, error: errorText(error), loading: false })); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}
