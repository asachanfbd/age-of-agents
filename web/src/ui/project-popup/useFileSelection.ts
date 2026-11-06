import { useCallback, useRef, useState } from 'react';

/** A selected file's load outcome: still loading (null), its content, or why it failed. */
export type FileLoad<T> = { value: T; error?: undefined } | { error: string; value?: undefined } | null;

/**
 * Tracks which file is selected in a file browser and loads its content. Loading happens in the
 * open handler rather than an effect, and only the most recent selection's result is kept — so
 * clicking through files quickly can never show an earlier file's content under a later name.
 */
export function useFileSelection<T>(loader: (path: string) => Promise<T>) {
  const [path, setPath] = useState<string | null>(null);
  const [load, setLoad] = useState<FileLoad<T>>(null);
  const latest = useRef(0);

  const open = useCallback(async (next: string) => {
    const ticket = ++latest.current;
    setPath(next);
    setLoad(null);
    try {
      const value = await loader(next);
      if (latest.current === ticket) setLoad({ value });
    } catch (failure) {
      if (latest.current === ticket) setLoad({ error: (failure as Error).message });
    }
  }, [loader]);

  /** Replaces the loaded content in place (after a save) without a reload. */
  const replace = useCallback((value: T) => setLoad({ value }), []);

  return { path, load, open, replace };
}
