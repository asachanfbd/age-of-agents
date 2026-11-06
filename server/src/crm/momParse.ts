export interface ParsedMom { summary: string; decisions: string; actionItems: string[] }

const HEADING = /^\s{0,3}(?:#{1,6}\s*)?(summary|decisions?|action items?)\s*:?\s*$/i;

/** Reads an agent's MOM text. Missing sections stay empty; text with no recognisable heading becomes the summary. */
export function parseMomOutput(text: string): ParsedMom {
  const out = { summary: '', decisions: '', action: [] as string[] };
  let section: 'summary' | 'decisions' | 'action' | null = null;
  const loose: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const h = HEADING.exec(line);
    if (h) { const k = h[1]!.toLowerCase(); section = k.startsWith('summary') ? 'summary' : k.startsWith('decision') ? 'decisions' : 'action'; continue; }
    if (section === null) { loose.push(line); continue; }
    if (section === 'action') { const item = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim(); if (item) out.action.push(item); }
    else out[section] += (out[section] ? '\n' : '') + line;
  }
  const summary = out.summary.trim() || (section === null ? loose.join('\n').trim() : '');
  return { summary, decisions: out.decisions.trim(), actionItems: out.action };
}
