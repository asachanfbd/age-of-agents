/** Which icon family a saved command gets, chosen from its name — build, test, lint, run (start/dev/serve), or a generic terminal. */
export type CommandIconKey = 'build' | 'test' | 'lint' | 'run' | 'generic';

const PATTERNS: [CommandIconKey, RegExp][] = [
  ['build', /build|compile|bundle|package/i],
  ['test', /test|spec|e2e/i],
  ['lint', /lint|format|prettier|typecheck|check/i],
  ['run', /start|run|dev|serve|watch/i],
];

export function commandIconKey(name: string): CommandIconKey {
  return PATTERNS.find(([, pattern]) => pattern.test(name))?.[0] ?? 'generic';
}
