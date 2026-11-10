import type { StepRunOutput } from '../domain/types.ts';

/** Why one `complete_step` output is malformed, or null when it is a valid StepRunOutput. */
function outputItemError(item: unknown, index: number): string | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return `outputs[${index}] must be an object`;
  const { name, format, content } = item as { name?: unknown; format?: unknown; content?: unknown };
  if (typeof name !== 'string' || !name.trim()) return `outputs[${index}].name is required`;
  if (format !== 'markdown' && format !== 'html') return `outputs[${index}].format must be "markdown" or "html"`;
  if (typeof content !== 'string') return `outputs[${index}].content must be a string`;
  return null;
}

const NOT_AN_ARRAY = 'outputs must be an array (or a JSON string of one)';

/**
 * `complete_step`'s raw `outputs` as a validated array (undefined when absent or null), or the
 * reason it is malformed. A JSON string holding the array is accepted, since some MCP clients
 * stringify large array arguments.
 */
export function parseStepOutputs(raw: unknown): { outputs: StepRunOutput[] | undefined } | { error: string } {
  if (raw === undefined || raw === null) return { outputs: undefined };
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return { error: NOT_AN_ARRAY }; }
  }
  if (!Array.isArray(value)) return { error: NOT_AN_ARRAY };
  for (const [index, item] of value.entries()) {
    const error = outputItemError(item, index);
    if (error) return { error };
  }
  return { outputs: value as StepRunOutput[] };
}
