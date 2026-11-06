import { INSIGHTS_MARKDOWN_MAX } from './limits.ts';
import { charCount } from './validate.ts';

export class InsightsAnswerError extends Error {}

const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/;

/** The agent's answer: strict JSON `{ markdown }` (a surrounding json code fence is tolerated), non-empty and at most `INSIGHTS_MARKDOWN_MAX` characters. */
export function parseInsightsAnswer(text: string): string {
  const trimmed = text.trim();
  const body = FENCE.exec(trimmed)?.[1] ?? trimmed;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new InsightsAnswerError('the answer is not JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new InsightsAnswerError('the answer is not an object');
  const keys = Object.keys(parsed);
  const markdown = (parsed as { markdown?: unknown }).markdown;
  if (keys.length !== 1 || typeof markdown !== 'string') throw new InsightsAnswerError('the answer must be exactly { "markdown": text }');
  if (!markdown.trim()) throw new InsightsAnswerError('the markdown is empty');
  if (charCount(markdown) > INSIGHTS_MARKDOWN_MAX) throw new InsightsAnswerError(`the markdown is longer than ${INSIGHTS_MARKDOWN_MAX} characters`);
  return markdown;
}
