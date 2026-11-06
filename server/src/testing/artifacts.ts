import { PathTraversalError, resolveSafePath } from '../projects/fileTree.ts';
import { normalizeRelativePath } from './validation.ts';

/**
 * Resolves a Collector's declared path to an absolute file inside one Test Run's artifact
 * directory. The config validator already rejects unsafe paths syntactically; this is the
 * disk-level guard every report read must go through, so a report is never read from outside the
 * run's own directory — not via `..`, an absolute path, or a symlink planted inside it.
 */
export async function resolveCollectorArtifactPath(artifactDir: string, collectorPath: string): Promise<string> {
  const normalized = normalizeRelativePath(collectorPath);
  if (normalized === null || normalized === '.') throw new PathTraversalError(collectorPath);
  return resolveSafePath(artifactDir, normalized);
}
