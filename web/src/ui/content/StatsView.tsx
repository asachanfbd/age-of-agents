import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { Platform } from '../../lib/contentRules';
import { EXTRACT_IMAGES_MAX, EXTRACT_TEXT_MAX, formatCount, formatWatchTime, hasWatchTime, NOTE_MAX, PLATFORM_STAT_FIELDS, summaryLine } from '../../lib/contentStats';
import type { StatForm } from '../../lib/contentStats';
import type { StatDto, StatsSummaryDto } from '../../lib/contentTypes';
import { instantToLocalText } from '../../lib/contentZone';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { ErrorNote } from '../crm/shared';
import { RelativeTime } from '../design/RelativeTime';

const deltaTone = (text: string) => (text.startsWith('+') ? 'text-success-foreground' : text.startsWith('−') ? 'text-destructive' : 'text-muted-foreground');

/** The latest numbers on the post row, each with its change since the snapshot before. An unknown count is left out, never shown as 0. */
export function StatsSummaryLine({ platform, stats, timeZone, now }: { platform: Platform; stats: StatsSummaryDto | null; timeZone: string; now?: number }) {
  if (!stats?.latest) return <span className="text-xs text-muted-foreground">No stats yet</span>;
  const items = summaryLine(platform, stats.latest, stats.delta);
  return (
    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs" aria-label="Latest stats">
      {items.map((i) => (
        <span key={i.label} className="tabular-nums"><span className="text-muted-foreground">{i.label} </span><strong>{i.value}</strong>{i.delta !== null && <span className={cn('ml-1', deltaTone(i.delta))}> {i.delta}</span>}</span>
      ))}
      <span className="text-muted-foreground">as of <RelativeTime at={stats.latest.capturedAt} timeZone={timeZone} now={now} /></span>
    </span>
  );
}

export interface StatsListProps {
  platform: Platform; format: string; snapshots: StatDto[]; timeZone: string; readOnly: boolean; confirmingId: string | null; error: string | null; now?: number;
  sourceUrl: (statId: string, sourceId: string) => string;
  onEdit: (stat: StatDto) => void; onAskDelete: (id: string) => void; onConfirmDelete: (id: string) => void; onCancelDelete: () => void;
}

/** Snapshots newest captured first: counts under the platform's labels ("—" for unknown), watch time, note and the kept sources. */
export function StatsList({ platform, format, snapshots, timeZone, readOnly, confirmingId, error, now, sourceUrl, onEdit, onAskDelete, onConfirmDelete, onCancelDelete }: StatsListProps) {
  if (!snapshots.length) return <p className="m-0 text-sm text-muted-foreground">No stats yet. Add the numbers you read from the platform.</p>;
  return (
    <ul className="m-0 grid list-none gap-2 p-0" aria-label="Stats snapshots">
      {snapshots.map((s) => (
        <li key={s.id} className="grid gap-2 rounded-card border border-border p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Captured <RelativeTime at={s.capturedAt} timeZone={timeZone} now={now} /> <span>({instantToLocalText(s.capturedAt, timeZone).replace('T', ' ')} {timeZone})</span></span>
            {confirmingId === s.id ? (
              <span className="flex items-center gap-1.5" role="alertdialog" aria-label="Confirm delete">Delete this snapshot?
                <Button size="sm" variant="destructive" onClick={() => onConfirmDelete(s.id)}>Delete</Button>
                <Button size="sm" variant="outline" onClick={onCancelDelete}>Keep</Button>
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <Button size="sm" variant="ghost" disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined} onClick={() => onEdit(s)}>Edit</Button>
                <Button size="sm" variant="ghost" aria-label="Delete snapshot" disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined} onClick={() => onAskDelete(s.id)}><Trash2 /></Button>
              </span>
            )}
          </div>
          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            {PLATFORM_STAT_FIELDS[platform].map((f) => (
              <div key={f.key} className="min-w-0"><dt className="text-xs text-muted-foreground">{f.label}</dt><dd className="m-0 break-words tabular-nums">{formatCount(s.counts[f.key])}</dd></div>
            ))}
            {hasWatchTime(format) && <div><dt className="text-xs text-muted-foreground">Average watch time</dt><dd className="m-0 tabular-nums">{formatWatchTime(s.watchTime)}</dd></div>}
          </dl>
          {s.note && <p className="m-0 text-sm">{s.note}</p>}
          {s.sources.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Sources">
              {s.sources.map((src) => (
                <li key={src.id}>
                  {src.kind === 'image'
                    ? <a href={sourceUrl(s.id, src.id)} target="_blank" rel="noopener noreferrer"><img src={sourceUrl(s.id, src.id)} alt={src.name} className="h-14 w-20 rounded border border-border object-cover" /></a>
                    : <a className="text-xs underline" href={sourceUrl(s.id, src.id)} target="_blank" rel="noopener noreferrer">{src.name}</a>}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
      <ErrorNote message={error} />
    </ul>
  );
}

const FromAgent = () => <span className="ml-1.5 rounded-full border border-info/50 bg-info/15 px-1.5 py-px text-[10px] font-medium text-info-foreground" data-from-agent>from agent</span>;

export interface StatsFormProps {
  platform: Platform; format: string; timeZone: string; form: StatForm; errors: Record<string, string>; saveError: string | null; pending: boolean; readOnly: boolean; editing: boolean;
  extractText: string; files: Array<{ name: string; size: number }>; extracting: boolean; uploadError: string | null; failure: string | null; unused: string | null;
  onField: (key: string, value: string) => void; onCaptured: (localText: string) => void; onWatch: (value: string) => void; onNote: (value: string) => void;
  onText: (value: string) => void; onFiles: (files: File[]) => void; onRemoveFile: (index: number) => void; onExtract: () => void; onSave: () => void; onCancel: () => void;
}

/** Add or edit a snapshot. The "Fill from text or screenshots" area pre-fills the form; nothing is saved until Save. */
export function StatsForm(p: StatsFormProps) {
  const { form, errors } = p;
  const mark = (key: string) => form.fromAgent.includes(key) && <FromAgent />;
  const err = (key: string) => errors[key] && <p role="alert" className="m-0 text-xs text-destructive">{errors[key]}</p>;
  return (
    <form className="grid gap-3 rounded-card border border-border p-3" aria-label={p.editing ? 'Edit stats' : 'Add stats'} onSubmit={(e) => { e.preventDefault(); p.onSave(); }}>
      {!p.editing && (
        <fieldset className="grid gap-2 rounded-card border border-dashed border-border p-2.5" aria-label="Fill from text or screenshots">
          <legend className="px-1 text-sm font-medium">Fill from text or screenshots</legend>
          <Textarea rows={3} value={p.extractText} aria-label="Pasted analytics text" placeholder={`Paste the platform's analytics text (up to ${EXTRACT_TEXT_MAX.toLocaleString('en-US')} characters)`} disabled={p.readOnly} onChange={(e) => p.onText(e.target.value)} />
          <label className="grid gap-1 rounded-card border border-dashed border-border p-2 text-xs text-muted-foreground">
            Drop or choose screenshots (1 to {EXTRACT_IMAGES_MAX}, PNG, JPEG or WebP, up to 10 MB each)
            <input type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="Screenshots" disabled={p.readOnly} onChange={(e) => { p.onFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          </label>
          {p.files.length > 0 && (
            <ul className="m-0 grid list-none gap-1 p-0 text-xs" aria-label="Chosen screenshots">
              {p.files.map((f, i) => <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2"><span className="truncate">{f.name} ({Math.ceil(f.size / 1024).toLocaleString('en-US')} KB)</span><Button type="button" size="sm" variant="ghost" aria-label={`Remove ${f.name}`} onClick={() => p.onRemoveFile(i)}>Remove</Button></li>)}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={p.extracting || p.readOnly} onClick={p.onExtract}>{p.extracting ? <><Loader2 className="animate-spin motion-reduce:animate-none" />Reading…</> : 'Extract'}</Button>
            {p.extracting && <span role="status" className="text-xs text-muted-foreground">The agent is reading. You can keep typing.</span>}
          </div>
          <ErrorNote message={p.uploadError} />
          {p.failure && <p role="alert" className="m-0 text-sm text-destructive" data-extraction-failure>{p.failure}</p>}
          {p.unused && <p role="status" className="m-0 text-xs text-muted-foreground" data-unused>{p.unused}</p>}
        </fieldset>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="stat-captured">Captured at <span className="text-muted-foreground">(in {p.timeZone})</span>{mark('capturedAt')}</Label>
        <Input id="stat-captured" type="datetime-local" value={form.capturedAt ? instantToLocalText(form.capturedAt, p.timeZone) : ''} aria-invalid={errors.capturedAt ? true : undefined} disabled={p.readOnly} onChange={(e) => p.onCaptured(e.target.value)} />
        {err('capturedAt')}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {PLATFORM_STAT_FIELDS[p.platform].map((f) => (
          <div key={f.key} className="grid gap-1">
            <Label htmlFor={`stat-${f.key}`}>{f.label}{mark(f.key)}</Label>
            <Input id={`stat-${f.key}`} inputMode="numeric" placeholder="—" value={form.counts[f.key] ?? ''} aria-invalid={errors[f.key] ? true : undefined} disabled={p.readOnly} onChange={(e) => p.onField(f.key, e.target.value)} />
            {err(f.key)}
          </div>
        ))}
        {hasWatchTime(p.format) && (
          <div className="grid gap-1">
            <Label htmlFor="stat-watch">Average watch time (seconds)</Label>
            <Input id="stat-watch" inputMode="decimal" placeholder="—" value={form.watchTime} aria-invalid={errors.watchTime ? true : undefined} disabled={p.readOnly} onChange={(e) => p.onWatch(e.target.value)} />
            {err('watchTime')}
          </div>
        )}
      </div>
      {err('counts')}
      <div className="grid gap-1">
        <Label htmlFor="stat-note">Note <span className="text-muted-foreground">(up to {NOTE_MAX.toLocaleString('en-US')} characters)</span></Label>
        <Textarea id="stat-note" rows={2} value={form.note} aria-invalid={errors.note ? true : undefined} disabled={p.readOnly} onChange={(e) => p.onNote(e.target.value)} />
        {err('note')}
      </div>
      <ErrorNote message={p.saveError} />
      <div className="flex gap-2">
        <Button type="submit" disabled={p.pending || p.readOnly}>{p.pending ? 'Saving…' : 'Save'}</Button>
        <Button type="button" variant="outline" disabled={p.pending} onClick={p.onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

