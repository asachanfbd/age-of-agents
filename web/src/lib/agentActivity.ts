export interface ActivityPart { title: string; text: string; code?: boolean }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const humanize = (value: string) => value.replace(/[_-]/g, ' ').replace(/^./, c => c.toUpperCase());
function readable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join('\n\n');
  if (value && typeof value === 'object') {
    const entry = object(value);
    if (typeof entry.text === 'string') return entry.text;
    return Object.entries(entry).map(([key, item]) => `${humanize(key)}: ${readable(item)}`).join('\n');
  }
  return value == null ? '' : String(value);
}

/** Convert recorded CLI events to reading-friendly activity without discarding the original. */
export function describeActivity(content: string, toolNames: Map<string, string>): ActivityPart[] {
  let event: Record<string, unknown>;
  try { event = object(JSON.parse(content)); } catch { return [{ title: 'Agent output', text: content }]; }
  const message = object(event.message);
  const blocks = Array.isArray(message.content) ? message.content : [];
  const parts: ActivityPart[] = blocks.map(value => {
    const block = object(value);
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'Tool';
      if (typeof block.id === 'string') toolNames.set(block.id, name);
      const input = object(block.input);
      const text = Object.entries(input).map(([key, item]) => `${humanize(key)}\n${readable(item)}`).join('\n\n');
      return { title: `Using ${name}`, text: text || 'No input parameters.', code: true };
    }
    if (block.type === 'tool_result') return { title: `${toolNames.get(String(block.tool_use_id)) ?? 'Tool'} ${block.is_error ? 'failed' : 'result'}`, text: readable(block.content) || 'Completed without output.', code: true };
    if (block.type === 'text') return { title: event.type === 'user' ? 'Input' : 'Agent message', text: readable(block.text) };
    if (block.type === 'thinking') return { title: 'Agent reasoning', text: readable(block.thinking) };
    return { title: humanize(String(block.type ?? 'Activity')), text: readable(block.text ?? block.content) || 'Additional details available in the raw event.' };
  });
  if (parts.length) return parts;
  if (typeof event.type === 'string' && event.type.startsWith('item.')) {
    const item = object(event.item);
    return [{ title: humanize(String(item.type ?? 'Activity')), text: readable(item.text ?? item.command ?? item.changes ?? item) + (item.aggregated_output ? `\n${readable(item.aggregated_output)}` : ''), code: item.type === 'command_execution' }];
  }
  if (event.type === 'thread.started') return [{ title: 'Codex session started', text: readable(event.thread_id) }];
  if (event.type === 'turn.completed') return [{ title: 'Run completed', text: readable(event.usage) }];
  if (event.type === 'result') return [{ title: event.is_error ? 'Run failed' : 'Run completed', text: readable(event.structured_output ?? event.result) || 'No additional output.' }];
  if (event.type === 'system') return [{ title: humanize(String(event.subtype ?? 'Session update')), text: readable(event.message) || [event.model && `Model: ${event.model}`, event.cwd && `Working directory: ${event.cwd}`, event.estimated_tokens != null && `Estimated tokens: ${event.estimated_tokens}`].filter(Boolean).join('\n') || 'Session status updated.' }];
  if (event.type === 'rate_limit_event') return [{ title: 'Usage limit update', text: readable(event.rate_limit_info) }];
  return [{ title: humanize(String(event.type ?? 'Activity')), text: readable(event.message ?? event.content ?? event.error) || 'Additional details available in the raw event.' }];
}

/**
 * True when `content` is a pure agent-message event — Claude's 'assistant' events whose blocks are
 * *all* `text` (no tool_use/tool_result/thinking mixed in), or Codex's 'item.completed' agent_message
 * — as opposed to one that also carries tool activity. Used by taskTranscript.ts's
 * `groupTranscriptSegments` to pull these out of the collapsed tool-run and show them as their own
 * chat bubble, so a running agent's messages read like a conversation instead of being buried behind
 * "Show activity".
 */
export function agentMessageText(content: string): string | null {
  let event: Record<string, unknown>;
  try { event = object(JSON.parse(content)); } catch { return null; }
  if (event.type === 'assistant') {
    const blocks = Array.isArray(object(event.message).content) ? (object(event.message).content as unknown[]) : [];
    if (blocks.length === 0 || !blocks.every((b) => object(b).type === 'text')) return null;
    const text = blocks.map((b) => readable(object(b).text)).join('\n\n').trim();
    return text || null;
  }
  if (event.type === 'item.completed' && object(event.item).type === 'agent_message') {
    const text = readable(object(event.item).text).trim();
    return text || null;
  }
  return null;
}

/**
 * True when `content` is a raw usage-limit reading (Claude's 'rate_limit_event', surfaced in
 * `describeActivity` as "Usage limit update"). Used by worldStore.ts's `isUsageLimitLogEvent` to
 * trigger an immediate executors refresh the moment a running Task reports fresh limits, rather than
 * waiting for the footer's 30s poll (see App.tsx).
 */
export function isUsageLimitEvent(content: string): boolean {
  try { return object(JSON.parse(content)).type === 'rate_limit_event'; } catch { return false; }
}
