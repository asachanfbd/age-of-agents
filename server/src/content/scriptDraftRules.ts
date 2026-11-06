/**
 * A script draft is copied straight into a teleprompter or voice-over, and its word count drives the estimated length,
 * so `save_draft` refuses a script that carries anything but spoken paragraphs. The rules are deliberately narrow:
 * a sentence that merely contains a colon, brackets or "Here is" is spoken text and passes.
 */

const LABEL_MAX_CODE_POINTS = 40;
const FIX = 'and save only the spoken script';

const isHeading = (line: string) => /^#{1,6}\s/.test(line);
const isFence = (line: string) => /^(```|~~~)/.test(line);
const isLabel = (line: string) => line.endsWith(':') && [...line].length <= LABEL_MAX_CODE_POINTS;
const isBracketed = (line: string) => /^(?:(?:\[[^[\]]*\]|\([^()]*\))\s*)+$/.test(line);
/** "Here is the script:", "Here's your draft": the agent introducing the text instead of speaking it. */
const isPreface = (line: string) => /^here(?:\s+is|['’]s)\b/i.test(line) && (/\b(?:script|draft|version)\b/i.test(line) || line.endsWith(':'));

function lineProblem(line: string, n: number): string | null {
  if (isHeading(line)) return `Remove the heading on line ${n} ${FIX}`;
  if (isFence(line)) return `Remove the code fence on line ${n} ${FIX}`;
  if (n === 1 && isPreface(line)) return `Remove the preface on line ${n} ${FIX}`;
  if (isLabel(line)) return `Remove the label "${line}" on line ${n} ${FIX}`;
  if (isBracketed(line)) return `Remove the bracketed direction on line ${n} ${FIX}`;
  return null;
}

/** The first problem by line, or null for a script of spoken paragraphs. Lines are counted on the trimmed text. */
export function scriptDraftProblem(text: string): string | null {
  const lines = text.trim().split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const problem = lineProblem(lines[i]!.trim(), i + 1);
    if (problem) return problem;
  }
  return null;
}
