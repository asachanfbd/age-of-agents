import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { contentApi } from '../../lib/contentApi';
import { evaluationDaysError } from '../../lib/contentResults';
import { canUseDetected, DEFAULT_SPEAKING_SPEED, SAMPLE_LIST_SCROLL_FROM, sampleRow, settingsSourceLabel, speakingSpeedError, speedPatch } from '../../lib/contentScript';
import { useContentStore } from '../../store/contentStore';
import { Badge } from '@/components/ui/badge';
import { controlsDisabled, READ_ONLY_TITLE, skillFileValue } from '../../lib/contentView';
import { browserTimezone, supportedTimezones, timezoneOptions } from '../../lib/contentZone';
import { errorText, useLoad } from '../crm/crmHooks';
import { ErrorNote } from '../crm/shared';

/** Name, time zone (a dropdown) and the Building folder agents are pointed at. Guards its own read-only state. */
export function SettingsTab({ projectId, readOnly, onSaved }: { projectId: string; readOnly: boolean; onSaved: () => void }) {
  const loaded = useLoad(() => contentApi.settings(projectId), [projectId]);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [skillFile, setSkillFile] = useState('');
  const [autoApply, setAutoApply] = useState(false);
  const [days, setDays] = useState('7');
  const [wpm, setWpm] = useState('150');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (loaded.data) { setName(loaded.data.name); setTimezone(loaded.data.timezone); setSkillFile(loaded.data.writingSkillFile ?? ''); setAutoApply(loaded.data.autoApplyRetro); setDays(String(loaded.data.evaluationDays)); setWpm(String(loaded.data.speakingSpeed.speakingWpm)); } }, [loaded.data]);
  const disabled = controlsDisabled(readOnly);
  // The speed as last read, saved or reported by the video agent: its source chip, and what an unchanged field is compared with.
  const storeSpeed = useContentStore((s) => s.speakingSpeedByProject[projectId]);
  const samples = useContentStore((s) => s.speakingSamplesByProject[projectId]) ?? [];
  const { loadSpeakingSpeed, loadSpeakingSamples, putSpeakingSpeed, deleteSpeakingSample, clearManualSpeed } = useContentStore.getState();
  const speed = storeSpeed ?? loaded.data?.speakingSpeed ?? DEFAULT_SPEAKING_SPEED;
  useEffect(() => { void loadSpeakingSpeed(projectId); void loadSpeakingSamples(projectId); }, [projectId, loadSpeakingSpeed, loadSpeakingSamples]);
  // A speed that arrives (saved elsewhere, reported by the agent) replaces the field only when the owner has not changed it.
  const shownSpeed = useRef(speed.speakingWpm);
  useEffect(() => {
    const before = String(shownSpeed.current);
    shownSpeed.current = speed.speakingWpm;
    setWpm((draft) => (draft === before ? String(speed.speakingWpm) : draft));
  }, [speed.speakingWpm]);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const sampleAction = async (work: Promise<{ ok: boolean; error?: string }>) => { const r = await work; setSampleError(r.ok ? null : r.error ?? 'Failed'); };
  const save = async () => {
    const problem = evaluationDaysError(days) ?? speakingSpeedError(wpm);
    if (problem) { setError(problem); setSaved(false); return; }
    try {
      const next = await contentApi.saveSettings(projectId, { name, timezone, writingSkillFile: skillFileValue(skillFile), autoApplyRetro: autoApply, evaluationDays: Number(days), ...speedPatch(wpm, speed) });
      putSpeakingSpeed(projectId, next.speakingSpeed); setError(null); setSaved(true); onSaved();
    } catch (e) { setError(errorText(e)); setSaved(false); }
  };
  if (!loaded.data) return <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"><ErrorNote message={loaded.error} /></div>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <section className="grid max-w-xl gap-4" aria-label="Content Studio settings">
        <div className="grid gap-2"><Label htmlFor="content-name">Name</Label><Input id="content-name" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} /></div>
        <div className="grid gap-2">
          <Label htmlFor="content-timezone">Time zone</Label>
          <NativeSelect id="content-timezone" wrapperClassName="w-full" value={timezone} disabled={disabled} onChange={(e) => setTimezone(e.target.value)}>
            {timezoneOptions(browserTimezone(), supportedTimezones(), loaded.data.timezone).map((z) => <option key={z} value={z}>{z}</option>)}
          </NativeSelect>
          <p className="m-0 text-xs text-muted-foreground">Post dates and the calendar days use this zone.</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="content-skill-file">Writing skill file</Label>
          <Input id="content-skill-file" value={skillFile} disabled={disabled} placeholder={loaded.data.defaultWritingSkillFile} onChange={(e) => setSkillFile(e.target.value)} />
          <p className="m-0 text-xs text-muted-foreground">Absolute path of the writing skill every text-writing session reads. Leave empty to use the default.</p>
        </div>
        <div className="grid gap-1">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input id="content-auto-apply" type="checkbox" checked={autoApply} disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined} onChange={(e) => setAutoApply(e.target.checked)} />
            Apply retro changes without review
          </label>
          <p className="m-0 text-xs text-muted-foreground">After a text is finalized, the retro's style changes go straight into the Writing style and show in its history as auto-applied. A change that no longer fits waits for you in Pending proposals.</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="content-evaluation-days">Judge a post after N days</Label>
          <Input id="content-evaluation-days" inputMode="numeric" value={days} disabled={disabled} aria-invalid={evaluationDaysError(days) ? true : undefined} onChange={(e) => setDays(e.target.value)} />
          <p className="m-0 text-xs text-muted-foreground">{evaluationDaysError(days) ?? 'Whole days from 1 to 90. A post is judged on its latest snapshot captured at least this long after publishing.'}</p>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="content-speaking-wpm">Speaking speed (words per minute)</Label>
            <Badge variant="outline" data-speed-source={speed.source}>{settingsSourceLabel(speed.source)}</Badge>
          </div>
          <Input id="content-speaking-wpm" inputMode="numeric" value={wpm} disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined} aria-invalid={speakingSpeedError(wpm) ? true : undefined} onChange={(e) => setWpm(e.target.value)} />
          <p className="m-0 text-xs text-muted-foreground">{speakingSpeedError(wpm) ?? 'Whole number from 20 to 400. The Script tab estimates the video length from it, for all Concepts. You can also change it from the Script footer. Typing a value replaces the detected speed.'}</p>
          <div className="grid gap-2" aria-label="Detected recordings">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">Detected recordings</span>
              {canUseDetected(speed) && <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => void sampleAction(clearManualSpeed(projectId))}>Use detected speed</Button>}
            </div>
            {samples.length === 0 ? (
              <p className="m-0 text-xs text-muted-foreground">No recordings yet. When you upload a facecam clip or a voice-over in a Video tab, the video agent measures how fast it is spoken and lists it here.</p>
            ) : (
              <ul className={`m-0 grid list-none gap-1 p-0 ${samples.length >= SAMPLE_LIST_SCROLL_FROM ? 'max-h-72 overflow-y-auto' : ''}`}>
                {samples.map((sample) => {
                  const row = sampleRow(sample);
                  return (
                    <li key={row.id} className="flex items-center gap-2 text-xs" data-sample={row.id}>
                      <span className="min-w-0 flex-1 truncate" title={row.name}>{row.name}</span>
                      <span className="font-medium tabular-nums">{row.wpm}</span>
                      <span className="tabular-nums text-muted-foreground">{row.detail}</span>
                      <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label={`Delete recording ${row.name}`} onClick={() => void sampleAction(deleteSpeakingSample(projectId, row.id))}>Delete</Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="m-0 text-xs text-muted-foreground">Deleting a media file removes its recording. A deleted recording comes back only when the agent measures that file again.</p>
            <ErrorNote message={sampleError} />
          </div>
        </div>
        <p className="m-0 text-sm">Folder for agents: <code className="break-all text-xs">{loaded.data.folder}</code></p>
        <ErrorNote message={error} />
        <div className="flex items-center gap-3"><Button disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined} onClick={() => void save()}>Save</Button>{saved && <span className="text-sm text-muted-foreground">Saved</span>}</div>
      </section>
    </div>
  );
}
