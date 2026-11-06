import { NativeSelect } from '@/components/ui/native-select';
import { Badge } from '@/components/ui/badge';
import { Section } from '../design/Header';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { crmApi } from '../../lib/crmApi';
import { inUseMessage, NUMBER_FIELDS, smtpFormFrom, smtpPayload, smtpStatusText, validateNumber } from '../../lib/crmSettings';
import type { NumberField, SmtpForm } from '../../lib/crmSettings';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import type { FollowupType, SettingsDto } from '../../lib/crmTypes';
import { useCrmStore } from '../../store/crmStore';
import { ErrorNote } from './shared';
import { errorText } from './crmHooks';
import type { CrmTabProps } from './types';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TYPES: FollowupType[] = ['call', 'message', 'email', 'dm', 'online_meeting', 'in_person_meeting', 'appointment', 'other'];
const TEMPLATE_CHANNELS = ['email', 'phone', 'instagram', 'facebook', 'linkedin', 'other'];

function Num({ field, value, disabled, onChange, label }: { field: NumberField; value: string; disabled: boolean; onChange: (v: string) => void; label?: string }) {
  const problem = validateNumber(field, value);
  return (
    <label className="grid gap-1 text-sm">{label ?? NUMBER_FIELDS[field].label}
      <Input aria-label={label ?? NUMBER_FIELDS[field].label} inputMode="numeric" className="h-8 w-32" value={value} disabled={disabled} aria-invalid={problem !== null} onChange={(e) => onChange(e.target.value)} />
      {problem && <span className="text-xs text-destructive">{problem}</span>}
    </label>
  );
}
const Check = ({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) => (
  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />{label}</label>
);

function Form({ project, settings, readOnly, onSaved }: { project: string; settings: SettingsDto; readOnly: boolean; onSaved: () => void }) {
  const disabled = crmControlsDisabled(readOnly);
  const save = useCrmStore((s) => s.saveSettings);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (patch: unknown, done = 'Saved.') => {
    setError(null); setMessage(null);
    const r = await save(project, patch);
    if (r.ok) { setMessage(done); onSaved(); } else setError(inUseMessage('lost reason', { status: r.status, message: r.error, details: r.details?.details as Record<string, unknown> | undefined }));
  };
  const s = settings;
  const [cad, setCad] = useState({ followups: String(s.cadence.followups), gapFirst: String(s.cadence.gapDays[0]), gapNext: String(s.cadence.gapDays[1]), retryHours: String(s.cadence.retryHours), retryTries: String(s.cadence.retryTries), resurfaceDays: String(s.cadence.resurfaceDays), autoLost: s.cadence.autoLost });
  const [{ form: smtp, passwordSaved }, setSmtp] = useState(() => smtpFormFrom(s.smtp));
  const [testTo, setTestTo] = useState('');
  const [caps, setCaps] = useState({ dailyCap: String(s.email.dailyCap), gapSeconds: String(s.email.gapSeconds), footer: s.emailFooter, onTime: String(s.onTimeMinutes), country: s.countryCode ? `+${s.countryCode}` : '' });
  const [approval, setApproval] = useState(s.approval);
  const [agents, setAgents] = useState(s.agentAutoApply);
  const [durations, setDurations] = useState<Record<string, string>>(Object.fromEntries(Object.entries(s.durations).map(([k, v]) => [k, String(v)])));
  const [sessions, setSessions] = useState({ messagesPer30: String(s.sessions.messagesPer30), callsPer30: String(s.sessions.callsPer30) });
  const [tz, setTz] = useState(s.timezone);
  const [hours, setHours] = useState(s.workingHours);
  const [slots, setSlots] = useState(s.dailySlots);
  const [templates, setTemplates] = useState(s.templates);
  const [tplKey, setTplKey] = useState({ channel: 'email', step: '0' });
  const [newReason, setNewReason] = useState('');
  const [newField, setNewField] = useState('');
  const [rename, setRename] = useState<{ from: string; to: string } | null>(null);

  const bad = (fields: Array<[NumberField, string]>) => fields.some(([f, v]) => validateNumber(f, v) !== null);
  const tplId = `${tplKey.channel}:${tplKey.step}`;

  return (
    <div className="grid gap-4" aria-label="CRM settings">
      <ErrorNote message={error} />
      {message && <p className="m-0 text-sm text-success-foreground" role="status">{message}</p>}

      <Section title="Cadence and retries">
        <div className="flex flex-wrap gap-3">
          <Num field="followups" value={cad.followups} disabled={disabled} onChange={(v) => setCad({ ...cad, followups: v })} />
          <Num field="gapFirst" value={cad.gapFirst} disabled={disabled} onChange={(v) => setCad({ ...cad, gapFirst: v })} />
          <Num field="gapNext" value={cad.gapNext} disabled={disabled} onChange={(v) => setCad({ ...cad, gapNext: v })} />
          <Num field="retryHours" value={cad.retryHours} disabled={disabled} onChange={(v) => setCad({ ...cad, retryHours: v })} />
          <Num field="retryTries" value={cad.retryTries} disabled={disabled} onChange={(v) => setCad({ ...cad, retryTries: v })} />
          <Num field="resurfaceDays" value={cad.resurfaceDays} disabled={disabled} onChange={(v) => setCad({ ...cad, resurfaceDays: v })} />
        </div>
        <div className="mt-2"><Check label="Auto-mark lost after the chain ends with no response" checked={cad.autoLost} disabled={disabled} onChange={(v) => setCad({ ...cad, autoLost: v })} /></div>
        <Button size="sm" className="mt-2" disabled={disabled || bad([['followups', cad.followups], ['gapFirst', cad.gapFirst], ['gapNext', cad.gapNext], ['retryHours', cad.retryHours], ['retryTries', cad.retryTries], ['resurfaceDays', cad.resurfaceDays]])} title={disabledTitle(readOnly)}
          onClick={() => void run({ cadence: { followups: Number(cad.followups), gapDays: [Number(cad.gapFirst), Number(cad.gapNext)], retryHours: Number(cad.retryHours), retryTries: Number(cad.retryTries), resurfaceDays: Number(cad.resurfaceDays), autoLost: cad.autoLost } })}>Save cadence</Button>
      </Section>

      <Section title="Email connection (SMTP)" actions={<Badge variant={s.smtp.status.state === 'connected' ? 'success' : s.smtp.status.state === 'needs_attention' ? 'soft-destructive' : 'secondary'}>{smtpStatusText(s.smtp.status)}</Badge>}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label="Host" placeholder="smtp.example.com" value={smtp.host} disabled={disabled} onChange={(e) => setSmtp((x) => ({ ...x, form: { ...x.form, host: e.target.value } }))} />
          <Input aria-label="Port" inputMode="numeric" value={smtp.port} disabled={disabled} onChange={(e) => setSmtp((x) => ({ ...x, form: { ...x.form, port: e.target.value } }))} />
          <NativeSelect aria-label="Security"  value={smtp.security} disabled={disabled} onChange={(e) => setSmtp((x) => ({ ...x, form: { ...x.form, security: e.target.value as SmtpForm['security'] } }))}><option value="starttls">STARTTLS</option><option value="ssl">SSL/TLS</option><option value="none">None</option></NativeSelect>
          <Input aria-label="User" placeholder="User" value={smtp.user} disabled={disabled} onChange={(e) => setSmtp((x) => ({ ...x, form: { ...x.form, user: e.target.value } }))} />
          <Input aria-label="From address" placeholder="you@example.com" value={smtp.from} disabled={disabled} onChange={(e) => setSmtp((x) => ({ ...x, form: { ...x.form, from: e.target.value } }))} />
          <Input aria-label="Password" type="password" autoComplete="new-password" placeholder={passwordSaved ? 'Saved. Leave empty to keep it.' : 'Password'} value={smtp.password} disabled={disabled} onChange={(e) => setSmtp((x) => ({ ...x, form: { ...x.form, password: e.target.value } }))} />
        </div>
        <p className="m-0 mt-1 text-xs text-muted-foreground">{passwordSaved ? 'A password is saved. It is never shown again.' : 'No password is saved.'}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={disabled || validateNumber('port', smtp.port) !== null} title={disabledTitle(readOnly)} onClick={() => void run(smtpPayload(smtp)).then(() => setSmtp((x) => ({ ...x, form: { ...x.form, password: '' } })))}>Save connection</Button>
          {passwordSaved && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run(smtpPayload(smtp, true), 'The saved password was removed.')}>Remove saved password</Button>}
          <Input aria-label="Send a test to" className="h-8 w-56" placeholder="Send a test to…" value={testTo} disabled={disabled} onChange={(e) => setTestTo(e.target.value)} />
          <Button size="sm" variant="outline" disabled={disabled || !testTo.trim()} onClick={() => void (async () => { setError(null); setMessage(null); try { await crmApi.testSmtp(project, testTo.trim()); setMessage('Test message sent.'); onSaved(); } catch (e) { setError(errorText(e)); onSaved(); } })()}>Send test</Button>
        </div>
      </Section>

      <Section title="Approval and agents">
        <div className="grid gap-1">
          {TEMPLATE_CHANNELS.map((c) => c === 'email'
            ? <Check key={c} label="Send email without approval" checked={approval[c] === true} disabled={disabled} onChange={(v) => setApproval({ ...approval, [c]: v })} />
            : null)}
          <p className="m-0 text-xs text-muted-foreground">Other channels are sent by hand and always use the Pending reachout popup.</p>
          <Check label="Apply message drafts without review" checked={agents.messageDrafts} disabled={disabled} onChange={(v) => setAgents({ ...agents, messageDrafts: v })} />
          <Check label="Apply MOMs without review" checked={agents.moms} disabled={disabled} onChange={(v) => setAgents({ ...agents, moms: v })} />
        </div>
        <Button size="sm" className="mt-2" disabled={disabled} title={disabledTitle(readOnly)} onClick={() => void run({ approval, agentAutoApply: agents })}>Save</Button>
      </Section>

      <Section title="Email limits, footer, on-time window and country code">
        <div className="flex flex-wrap gap-3">
          <Num field="dailyCap" value={caps.dailyCap} disabled={disabled} onChange={(v) => setCaps({ ...caps, dailyCap: v })} />
          <Num field="gapSeconds" value={caps.gapSeconds} disabled={disabled} onChange={(v) => setCaps({ ...caps, gapSeconds: v })} />
          <Num field="onTimeMinutes" value={caps.onTime} disabled={disabled} onChange={(v) => setCaps({ ...caps, onTime: v })} />
          <label className="grid gap-1 text-sm">Default country code<Input aria-label="Default country code" className="h-8 w-28" placeholder="+49" value={caps.country} disabled={disabled} onChange={(e) => setCaps({ ...caps, country: e.target.value })} /></label>
        </div>
        <label className="mt-2 grid gap-1 text-sm">Opt-out footer for cold emails<Textarea aria-label="Opt-out footer" className="min-h-16" value={caps.footer} disabled={disabled} onChange={(e) => setCaps({ ...caps, footer: e.target.value })} /></label>
        <Button size="sm" className="mt-2" disabled={disabled || bad([['dailyCap', caps.dailyCap], ['gapSeconds', caps.gapSeconds], ['onTimeMinutes', caps.onTime]])} title={disabledTitle(readOnly)}
          onClick={() => void run({ email: { dailyCap: Number(caps.dailyCap), gapSeconds: Number(caps.gapSeconds) }, onTimeMinutes: Number(caps.onTime), emailFooter: caps.footer, countryCode: caps.country.trim() === '' ? null : caps.country.trim() })}>Save</Button>
      </Section>

      <Section title="Durations and session sizes">
        <div className="flex flex-wrap gap-3">
          {TYPES.map((t) => <Num key={t} field="duration" label={`${t.replace(/_/g, ' ')} (min)`} value={durations[t] ?? ''} disabled={disabled} onChange={(v) => setDurations({ ...durations, [t]: v })} />)}
          <Num field="messagesPer30" value={sessions.messagesPer30} disabled={disabled} onChange={(v) => setSessions({ ...sessions, messagesPer30: v })} />
          <Num field="callsPer30" value={sessions.callsPer30} disabled={disabled} onChange={(v) => setSessions({ ...sessions, callsPer30: v })} />
        </div>
        <Button size="sm" className="mt-2" disabled={disabled || TYPES.some((t) => validateNumber('duration', durations[t] ?? '') !== null) || bad([['messagesPer30', sessions.messagesPer30], ['callsPer30', sessions.callsPer30]])} title={disabledTitle(readOnly)}
          onClick={() => void run({ durations: Object.fromEntries(TYPES.map((t) => [t, Number(durations[t])])), sessions: { messagesPer30: Number(sessions.messagesPer30), callsPer30: Number(sessions.callsPer30) } })}>Save</Button>
      </Section>

      <Section title="Working hours and timezone">
        <Input aria-label="Timezone" className="mb-2 h-8 w-64" placeholder="Europe/Berlin" value={tz} disabled={disabled} onChange={(e) => setTz(e.target.value)} />
        <div className="grid gap-1">
          {hours.map((d, i) => (
            <div key={DAYS[i]} className="flex items-center gap-2 text-sm">
              <span className="w-24">{DAYS[i]}</span>
              <input type="checkbox" aria-label={`${DAYS[i]} is a working day`} checked={d.open} disabled={disabled} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, open: e.target.checked } : x)))} />
              <Input aria-label={`${DAYS[i]} start`} type="time" className="h-8 w-28" value={d.start} disabled={disabled || !d.open} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
              <Input aria-label={`${DAYS[i]} end`} type="time" className="h-8 w-28" value={d.end} disabled={disabled || !d.open} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
            </div>
          ))}
        </div>
        <Button size="sm" className="mt-2" disabled={disabled} title={disabledTitle(readOnly)} onClick={() => void run({ timezone: tz, workingHours: hours })}>Save</Button>
      </Section>

      <Section title="Daily slots">
        <div className="grid gap-2">
          {slots.map((sl, i) => (
            <div key={sl.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Input aria-label="Slot name" className="h-8 w-52" value={sl.name} disabled={disabled} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input aria-label="Slot minutes" inputMode="numeric" className="h-8 w-24" value={sl.minutes} disabled={disabled} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, minutes: Number(e.target.value.replace(/\D/g, '')) } : x)))} />
              <label className="flex items-center gap-1">Start <Input aria-label="Slot start" type="time" className="h-8 w-28" value={sl.start ?? ''} disabled={disabled} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, start: e.target.value || null } : x)))} /></label>
              <span className="text-xs text-muted-foreground">{sl.start ? 'fixed start' : 'anywhere in free time'}</span>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setSlots(slots.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => setSlots([...slots, { id: '', name: `Slot ${slots.length + 1}`, minutes: 30, start: null }])}>Add a slot</Button>
            <Button size="sm" disabled={disabled} title={disabledTitle(readOnly)} onClick={() => void run({ dailySlots: slots })}>Save slots</Button></div>
        </div>
      </Section>

      <Section title="Templates">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <NativeSelect aria-label="Template channel"  value={tplKey.channel} onChange={(e) => setTplKey({ ...tplKey, channel: e.target.value })}>{TEMPLATE_CHANNELS.map((c) => <option key={c}>{c}</option>)}</NativeSelect>
          <NativeSelect aria-label="Template step"  value={tplKey.step} onChange={(e) => setTplKey({ ...tplKey, step: e.target.value })}>{Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i === 0 ? 'Reachout' : `Followup ${i}`}</option>)}</NativeSelect>
        </div>
        <Textarea aria-label="Template text" className="mt-2 min-h-24" placeholder="Hi {name}, … Fields: {name} {company} {title} and your custom fields" value={templates[tplId] ?? ''} disabled={disabled} onChange={(e) => setTemplates({ ...templates, [tplId]: e.target.value })} />
        <Button size="sm" className="mt-2" disabled={disabled} title={disabledTitle(readOnly)} onClick={() => void run({ templates: { [tplId]: templates[tplId] ?? '' } })}>Save template</Button>
      </Section>

      <Section title="Lost reasons">
        <ul className="m-0 grid list-none gap-1 p-0 text-sm">
          {s.lostReasons.map((r) => (
            <li key={r} className="flex items-center gap-2">
              {rename?.from === r ? (
                <><Input aria-label="Rename reason" className="h-8 w-56" value={rename.to} onChange={(e) => setRename({ from: r, to: e.target.value })} /><Button size="sm" onClick={() => void (async () => { setError(null); try { await crmApi.renameLostReason(project, r, rename.to); setRename(null); onSaved(); } catch (e) { setError(errorText(e)); } })()}>Save</Button><Button size="sm" variant="ghost" onClick={() => setRename(null)}>Cancel</Button></>
              ) : (
                <><span className="w-56">{r}</span><Button size="sm" variant="outline" disabled={disabled} onClick={() => setRename({ from: r, to: r })}>Rename</Button>
                  <Button size="sm" variant="ghost" disabled={disabled || s.lostReasons.length <= 1} onClick={() => void run({ lostReasons: s.lostReasons.filter((x) => x !== r) }, 'Reason removed.')}>Delete</Button></>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2"><Input aria-label="New lost reason" className="h-8 w-56" value={newReason} disabled={disabled} onChange={(e) => setNewReason(e.target.value)} /><Button size="sm" disabled={disabled || !newReason.trim()} onClick={() => void run({ lostReasons: [...s.lostReasons, newReason.trim()] }, 'Reason added.').then(() => setNewReason(''))}>Add reason</Button></div>
      </Section>

      <Section title="Custom fields">
        <ul className="m-0 grid list-none gap-1 p-0 text-sm">
          {s.customFields.map((f) => (
            <li key={f.id} className="flex items-center gap-2"><span className="w-56">{f.name}</span>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void (async () => { setError(null); try { await crmApi.deleteCustomField(project, f.id); onSaved(); } catch (e) { setError(inUseMessage('custom field', { message: errorText(e), details: (e as { details?: { details?: Record<string, unknown> } }).details?.details })); } })()}>Delete</Button></li>
          ))}
          {s.customFields.length === 0 && <li className="text-muted-foreground">No custom fields yet (up to 20, text only).</li>}
        </ul>
        <div className="mt-2 flex gap-2"><Input aria-label="New custom field" className="h-8 w-56" value={newField} disabled={disabled} onChange={(e) => setNewField(e.target.value)} />
          <Button size="sm" disabled={disabled || !newField.trim()} onClick={() => void (async () => { setError(null); try { await crmApi.addCustomField(project, newField.trim()); setNewField(''); onSaved(); } catch (e) { setError(errorText(e)); } })()}>Add field</Button></div>
      </Section>
    </div>
  );
}

/** Settings: cadence, the email connection (write-only password), approvals, templates, hours, slots, reasons and custom fields. */
export function SettingsTab({ project, readOnly }: CrmTabProps) {
  const settings = useCrmStore((s) => s.settingsByProject[project.id]);
  const load = useCrmStore((s) => s.loadSettings);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => { void load(project.id).then((r) => setError(r.ok ? null : r.error)); }, [project.id, load, version]);
  return (
    <div className="grid gap-4" aria-label="Settings">
      <ErrorNote message={error} />
      {!settings && !error && <p className="m-0 text-sm text-muted-foreground">Loading settings…</p>}
      {settings && <Form key={`${project.id}-${version}`} project={project.id} settings={settings} readOnly={readOnly} onSaved={() => setVersion((v) => v + 1)} />}
    </div>
  );
}
