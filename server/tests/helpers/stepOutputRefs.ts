import { readFileSync } from 'node:fs';

/** One earlier output a prompt references by its saved file (see worker/workflowPrompt.ts's `formatOutput`). */
export interface OutputRef {
  name: string;
  format: string;
  size: string;
  path: string;
}

/** Every output a prompt or message references by path, in order. */
export function outputRefs(prompt: string): OutputRef[] {
  const pattern = /^Output: (.+) \((html|markdown), ([^)]+)\)\nAbsolute path: (.+)$/gm;
  return [...prompt.matchAll(pattern)].map((m) => ({ name: m[1]!, format: m[2]!, size: m[3]!, path: m[4]! }));
}

/** The contents of every file a prompt references, in order — what a session that read them all would see. */
export function referencedContents(prompt: string): string[] {
  return outputRefs(prompt).map((ref) => readFileSync(ref.path, 'utf-8'));
}
