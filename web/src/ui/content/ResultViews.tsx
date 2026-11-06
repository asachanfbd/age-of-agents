import { cn } from '@/lib/utils';
import { PLATFORM_LABELS } from '../../lib/contentRules';
import type { Platform } from '../../lib/contentRules';
import { chipText, FIELD_STATE_WORDS, formatTargetValue, platformSummaryLines, RESULT_BADGES, RESULT_FILTER_LABELS, targetFieldLabel } from '../../lib/contentResults';
import { TARGET_FIELDS } from '../../lib/contentTargets';
import type { OverallResult } from '../../lib/contentTargets';
import type { PlatformResultSummaryDto, PostResultDto } from '../../lib/contentTypes';
import { NativeSelect } from '@/components/ui/native-select';
import { RelativeTime } from '../design/RelativeTime';

/** The overall result as an icon and a word; colour is never the only signal. */
export function OverallBadge({ overall }: { overall: OverallResult }) {
  const badge = RESULT_BADGES[overall];
  return <span data-result={overall} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', badge.tone)}><span aria-hidden>{badge.icon}</span>{badge.label}</span>;
}

/** A published post's result against its platform's targets: per-field chips and the overall badge, or the too-early progress. */
export function PostResultView({ platform, result, timeZone, now, onSetTargets }: { platform: Platform; result: PostResultDto; timeZone: string; now?: number; onSetTargets?: () => void }) {
  const rate = result.engagementRate === null ? '—' : `${result.engagementRate}%`;
  return (
    <div className="mt-1 grid gap-1 text-xs" aria-label="Result against targets">
      <span className="flex flex-wrap items-center gap-1.5"><OverallBadge overall={result.overall} /><span className="text-muted-foreground">Engagement rate {rate}</span></span>
      {result.overall === 'no-target' && (
        <span className="text-muted-foreground">No targets set for {PLATFORM_LABELS[platform]}.{onSetTargets && <> <button type="button" className="underline" onClick={onSetTargets}>Set targets</button></>}</span>
      )}
      {result.overall === 'too-early' && result.progress && (
        <span className="text-muted-foreground">
          Judged on <RelativeTime at={result.progress.judgedOn} timeZone={timeZone} now={now} /> · Day {result.progress.day} of {result.progress.of}
          {TARGET_FIELDS.filter((f) => result.progress!.counts[f] !== null).map((f) => <span key={f}> · {targetFieldLabel(platform, f)} {formatTargetValue(f, result.progress!.counts[f])}</span>)}
        </span>
      )}
      {result.fields.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {result.fields.map((f) => {
            const words = FIELD_STATE_WORDS[f.state];
            return <li key={f.field} data-state={f.state} className={cn('inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5', words.tone)}><span aria-hidden>{words.icon}</span>{chipText(platform, f)}</li>;
          })}
        </ul>
      )}
    </div>
  );
}

/** The Content list's "Overall result" filter. */
export function ResultFilter({ value, onChange }: { value: '' | OverallResult; onChange: (next: '' | OverallResult) => void }) {
  return (
    <NativeSelect aria-label="Overall result" value={value} onChange={(e) => onChange(e.target.value as '' | OverallResult)}>
      {(Object.keys(RESULT_FILTER_LABELS) as Array<'' | OverallResult>).map((k) => <option key={k} value={k}>{RESULT_FILTER_LABELS[k]}</option>)}
    </NativeSelect>
  );
}

/** One line per platform that has published posts: "LinkedIn: 4 of 9 judged posts on target". */
export function PlatformSummary({ summary }: { summary: PlatformResultSummaryDto[] | undefined }) {
  const lines = platformSummaryLines(summary ?? []);
  if (!lines.length) return null;
  return <ul className="m-0 grid list-none gap-0.5 p-0 text-sm text-muted-foreground" aria-label="Results by platform">{lines.map((l) => <li key={l}>{l}</li>)}</ul>;
}

/** The Concept row's per-post badges: platform name and its overall result. */
export function ConceptResultBadges({ posts }: { posts: Array<{ id: string; platform: Platform; result: PostResultDto | null }> }) {
  const judged = posts.filter((p) => p.result);
  if (!judged.length) return null;
  return <span className="flex flex-wrap gap-1.5" aria-label="Results">{judged.map((p) => <span key={p.id} className="inline-flex items-center gap-1 text-xs text-muted-foreground">{PLATFORM_LABELS[p.platform]} <OverallBadge overall={p.result!.overall} /></span>)}</span>;
}
