import { SeoInputError, SeoUpstreamError } from './errors.ts';
import type { ReportAgentInput } from './keywordAgent.ts';
import type { AiSummary, Mover, ReportData } from './reportBuild.ts';
import { changeText, periodLabel, sideText } from './reportExport.ts';

export const MAX_SUMMARY_PARAGRAPH = 2000;
export const MAX_SUMMARY_ACTIONS = 6;
export const MAX_SUMMARY_ACTION = 300;
const MOVERS_SENT = 5;

const moverLine = (kind: string, m: Mover): string => `${kind}: ${m.name} (${m.clicksPrevious} to ${m.clicksCurrent} clicks)`;

/** What the agent is told: the period, the scorecard as text and the biggest movers. Never tokens, property ids or file paths. */
export function summaryInput(buildingId: string, report: ReportData): ReportAgentInput {
  const movers = (['pages', 'keywords', 'clusters'] as const).flatMap((key) => [
    ...report.movers[key].gains.slice(0, MOVERS_SENT).map((m) => moverLine(`${key} gain`, m)),
    ...report.movers[key].losses.slice(0, MOVERS_SENT).map((m) => moverLine(`${key} loss`, m)),
  ]);
  return {
    buildingId, site: report.site, period: periodLabel(report),
    scorecard: report.tiles.map((t) => `${t.label}: ${sideText(t, 'current')} (comparison ${sideText(t, 'previous')})${changeText(t) ? `, ${changeText(t)}` : ''}`),
    movers, notes: report.notes,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the agent's answer: one paragraph and a short list of actions. An empty or malformed answer is an error. */
export function parseSummary(raw: unknown): { paragraph: string; actions: string[] } {
  if (!isObject(raw) || typeof raw.paragraph !== 'string' || !Array.isArray(raw.actions)) throw new SeoUpstreamError('The agent did not return a summary');
  const paragraph = raw.paragraph.trim();
  if (!paragraph) throw new SeoUpstreamError('The agent returned an empty summary');
  if (paragraph.length > MAX_SUMMARY_PARAGRAPH) throw new SeoUpstreamError('The agent\'s summary was too long');
  const actions = raw.actions.filter((a): a is string => typeof a === 'string').map((a) => a.trim().slice(0, MAX_SUMMARY_ACTION)).filter(Boolean).slice(0, MAX_SUMMARY_ACTIONS);
  return { paragraph, actions };
}

export const summaryOf = (parsed: { paragraph: string; actions: string[] }, report: ReportData, generatedAt: string): AiSummary => ({
  ...parsed, generatedAt, periodKey: report.period.key, digest: report.digest, label: 'AI-generated',
});

/** A summary sent back by the page when saving: the same shape, with every field checked. */
export function readSentSummary(value: unknown): AiSummary | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || typeof value.generatedAt !== 'string' || typeof value.periodKey !== 'string' || typeof value.digest !== 'string') throw new SeoInputError('summary must be a summary this app generated');
  let parsed: { paragraph: string; actions: string[] };
  try { parsed = parseSummary(value); } catch (error) { throw new SeoInputError(error instanceof Error ? error.message : 'summary is not valid'); }
  return { ...parsed, generatedAt: value.generatedAt.slice(0, 40), periodKey: value.periodKey.slice(0, 300), digest: value.digest.slice(0, 64), label: 'AI-generated' };
}
