import type { StepRunOutput, WorkflowStep } from '../domain/types.ts';

/** `complete_step` on a step with a `requiredOutputFormat` that carried no valid output of it — the message is the nudge the agent retries from. */
export class StepOutputRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepOutputRequiredError';
  }
}

/** Below this many characters (after trimming) an "HTML document" cannot be a usable mockup. */
export const MIN_HTML_OUTPUT_LENGTH = 100;

const HTML_DOCUMENT_TAG = /<!doctype html|<html[\s>]|<body[\s>]/i;
const PLACEHOLDER_TOKENS = new Set(['placeholder', 'todo', 'tbd', '...', '…']);

function isPlaceholder(text: string): boolean {
  return text === '' || PLACEHOLDER_TOKENS.has(text.toLowerCase());
}

/** Why `output` is not a real HTML mockup, or null when it is one. */
export function htmlOutputProblem(output: StepRunOutput): string | null {
  if (output.format !== 'html') return `wrong format "${output.format}" (needs "html")`;
  const content = output.content.trim();
  if (!content) return 'empty content';
  if (isPlaceholder(content)) return 'placeholder content';
  if (!HTML_DOCUMENT_TAG.test(content)) return 'no HTML document tag (<!doctype html>, <html> or <body>)';
  if (isPlaceholder(content.replace(/<[^>]*>/g, '').trim())) return 'placeholder content';
  if (content.length < MIN_HTML_OUTPUT_LENGTH) return `too short (under ${MIN_HTML_OUTPUT_LENGTH} characters)`;
  return null;
}

/** The refusal text: what is missing, how to send it, and why each sent output was rejected. */
export function requiredHtmlOutputMessage(outputs: StepRunOutput[]): string {
  const lines = [
    'UI mockup missing: this step must include at least one HTML mockup in complete_step\'s `outputs`. '
      + 'Outputs are not project files, so this read-only step can and must send them. '
      + 'Call complete_step again with `outputs: [{ name: "<screen name>", format: "html", content: "<!doctype html>…full self-contained page…" }]`, one entry per screen. '
      + 'Put CSS and JS inline and load no external assets. '
      + 'If several mockups are too large for one call, make each one more compact rather than leaving any out. '
      + 'If this task really has no UI surface, call skip_step with a reason instead.',
  ];
  if (outputs.length > 0) {
    lines.push('', 'Rejected outputs:');
    for (const output of outputs) lines.push(`- "${output.name}": ${htmlOutputProblem(output)}`);
  }
  return lines.join('\n');
}

/** Throws StepOutputRequiredError unless `outputs` satisfies `step.requiredOutputFormat`; a step without one accepts anything. */
export function assertRequiredOutputs(step: WorkflowStep, outputs: StepRunOutput[] | undefined): void {
  if (step.requiredOutputFormat !== 'html') return;
  const sent = outputs ?? [];
  if (sent.some((output) => htmlOutputProblem(output) === null)) return;
  throw new StepOutputRequiredError(requiredHtmlOutputMessage(sent));
}
