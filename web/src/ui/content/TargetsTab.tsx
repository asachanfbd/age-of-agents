import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PLATFORMS, PLATFORM_LABELS } from '../../lib/contentRules';
import type { Platform } from '../../lib/contentRules';
import { formFromTargets, formatTargetValue, targetBody, targetFieldLabel, targetFormErrors, targetsDirty, targetsSetCount } from '../../lib/contentResults';
import type { TargetFormValues } from '../../lib/contentResults';
import { TARGET_FIELDS } from '../../lib/contentTargets';
import type { TargetField, Targets } from '../../lib/contentTargets';
import type { TargetHistoryDto } from '../../lib/contentTypes';
import { controlsDisabled, READ_ONLY_TITLE } from '../../lib/contentView';
import { useContentInsightsStore } from '../../store/contentInsightsStore';
import { ErrorNote } from '../crm/shared';
import { RelativeTime } from '../design/RelativeTime';

const HINT = 'Counts are whole numbers; engagement rate is a percent with up to 2 decimals. Leave a field empty for no target.';

/** One platform's targets: seven optional fields, a count of those set and its own Save. */
export function PlatformTargetsCard({ platform, saved, values, errors, readOnly, saving, saveError, onChange, onSave }: {
  platform: Platform; saved: Targets; values: TargetFormValues; errors: Partial<Record<TargetField, string>>; readOnly: boolean; saving?: boolean; saveError?: string | null;
  onChange: (field: TargetField, text: string) => void; onSave: () => void;
}) {
  const disabled = controlsDisabled(readOnly);
  const set = targetsSetCount(saved);
  const problems = Object.keys(errors).length;
  const dirty = targetsDirty(saved, values);
  return (
    <section className="grid min-w-0 gap-3 rounded-card border border-border bg-card p-3.5" aria-label={`${PLATFORM_LABELS[platform]} targets`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-base font-semibold">{PLATFORM_LABELS[platform]}</h3>
        <span className="text-xs text-muted-foreground">{set} of {TARGET_FIELDS.length} set</span>
      </div>
      {set === 0 && <p className="m-0 text-xs text-muted-foreground">No targets set. Posts on {PLATFORM_LABELS[platform]} show "No target".</p>}
      <div className="grid gap-2.5 sm:grid-cols-2">
        {TARGET_FIELDS.map((field) => {
          const id = `target-${platform}-${field}`, error = errors[field];
          return (
            <div key={field} className="grid min-w-0 gap-1">
              <Label htmlFor={id}>{targetFieldLabel(platform, field)}{field === 'engagementRate' && ' (%)'}</Label>
              <Input id={id} inputMode="decimal" value={values[field]} placeholder="Not set" disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined}
                aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} onChange={(e) => onChange(field, e.target.value)} />
              {error && <p id={`${id}-error`} className="m-0 text-xs text-destructive">{error}</p>}
            </div>
          );
        })}
      </div>
      {readOnly && <p className="m-0 text-xs text-muted-foreground">This Building is read-only, so targets cannot be changed.</p>}
      <ErrorNote message={saveError ?? null} />
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={saving || !dirty || problems > 0} onClick={onSave}>Save {PLATFORM_LABELS[platform]}</Button>
          {problems > 0 && <span className="text-xs text-destructive">Fix {problems} {problems === 1 ? 'field' : 'fields'} to save</span>}
        </div>
      )}
    </section>
  );
}

/** The evaluation window, the engagement formula and the value rules. */
export function TargetsNote({ evaluationDays, onOpenSettings }: { evaluationDays: number; onOpenSettings?: () => void }) {
  return (
    <p className="m-0 max-w-3xl text-sm text-muted-foreground">
      Posts are judged {evaluationDays} days after publishing (<button type="button" className="underline" onClick={onOpenSettings}>change in Settings</button>). Every post on a platform follows that platform's targets, and a change applies to past posts too.
      Engagement is likes + comments + shares + saves; engagement rate is engagement divided by views (impressions on LinkedIn and X) × 100. {HINT}
    </p>
  );
}

/** Who changed what and when, newest first (the server keeps 50). */
export function TargetHistoryList({ entries, timeZone }: { entries: TargetHistoryDto[]; timeZone: string }) {
  if (!entries.length) return <p className="m-0 text-sm text-muted-foreground">No changes yet.</p>;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0 text-sm" aria-label="Target history">
      {entries.map((e) => {
        const changed = TARGET_FIELDS.filter((f) => e.before[f] !== e.after[f]);
        return (
          <li key={e.id} className="flex flex-wrap gap-x-2">
            <span className="text-muted-foreground"><RelativeTime at={e.at} timeZone={timeZone} /></span>
            <span>{e.who === 'person' ? 'You' : e.who}</span>
            <span>{PLATFORM_LABELS[e.platform]}:</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{changed.map((f) => `${targetFieldLabel(e.platform, f)} ${formatTargetValue(f, e.before[f])} → ${formatTargetValue(f, e.after[f])}`).join(', ')}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The Targets tab: one card per platform, the evaluation window note, the engagement formula and the history. Guards its own read-only state. */
export function TargetsTab({ projectId, readOnly, timeZone, onOpenSettings }: { projectId: string; readOnly: boolean; timeZone: string; onOpenSettings?: () => void }) {
  const data = useContentInsightsStore((s) => s.targetsByProject[projectId]);
  const history = useContentInsightsStore((s) => s.targetHistoryByProject[projectId]) ?? [];
  const { loadTargets, saveTargets, loadTargetHistory } = useContentInsightsStore.getState();
  const [drafts, setDrafts] = useState<Partial<Record<Platform, TargetFormValues>>>({});
  const [saveErrors, setSaveErrors] = useState<Partial<Record<Platform, string>>>({});
  const [saving, setSaving] = useState<Platform | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => { void loadTargets(projectId).then((r) => setLoadError(r.ok ? null : r.error)); void loadTargetHistory(projectId); }, [projectId, loadTargets, loadTargetHistory]);
  if (!data) return <ErrorNote message={loadError} />;
  const valuesOf = (p: Platform): TargetFormValues => drafts[p] ?? formFromTargets(data.targets[p]);
  const save = async (platform: Platform) => {
    setSaving(platform);
    const result = await saveTargets(projectId, platform, targetBody(valuesOf(platform)));
    setSaving(null);
    setSaveErrors((e) => ({ ...e, [platform]: result.ok ? undefined : result.error }));
    if (result.ok) setDrafts((d) => ({ ...d, [platform]: undefined }));
  };
  return (
    <div className="grid gap-5">
      <TargetsNote evaluationDays={data.evaluationDays} onOpenSettings={onOpenSettings} />
      <div className="grid gap-3 lg:grid-cols-2">
        {PLATFORMS.map((p) => (
          <PlatformTargetsCard key={p} platform={p} saved={data.targets[p]} values={valuesOf(p)} errors={targetFormErrors(valuesOf(p))} readOnly={readOnly} saving={saving === p} saveError={saveErrors[p]}
            onChange={(field, text) => setDrafts((d) => ({ ...d, [p]: { ...valuesOf(p), [field]: text } }))} onSave={() => void save(p)} />
        ))}
      </div>
      <section className="grid gap-2" aria-label="History">
        <h3 className="m-0 text-base font-semibold">History</h3>
        <TargetHistoryList entries={history} timeZone={timeZone} />
      </section>
    </div>
  );
}
