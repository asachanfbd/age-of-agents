import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Ban, CalendarPlus, Copy, Ellipsis, MessageSquare, Trash2, UserCheck, UserX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { crmApi } from '../../lib/crmApi';
import { BOARD_STAGES, contactLabel, itemContactLabel } from '../../lib/crmBoard';
import { canMarkDone, isMessageType } from '../../lib/crmCalendar';
import { channelBadges, commentCounter, detailRows, plannedDueAt, SEGMENT_LABEL, timelineAccent, timelineNewestFirst } from '../../lib/crmProspects';
import { undoRefusal } from '../../lib/crmMerge';
import { profileCompleteness, REOPEN_STAGES, reopenLabel, reopenStageParam, roleLine } from '../../lib/crmCustomers';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import type { ChannelType, ContactDto, FollowupDto, FollowupType, Stage, TimelineEntryDto } from '../../lib/crmTypes';
import { initials } from '../../lib/people';
import { IconButton } from '../design/Buttons';
import { ItemCard, ScoreRing } from '../design/Cards';
import { RelativeTime } from '../design/RelativeTime';
import { KpiRow, PageHeader, Section } from '../design/Header';
import { ChannelIcon } from './channelIcons';
import { MomDialog } from './MomDialog';
import { ReachoutPopup } from './ReachoutPopup';
import { ResponseForm } from './ResponseForm';
import { ErrorNote } from './shared';
import { errorText, useLoad } from './crmHooks';
import { WorkEntryBody } from './WorkLog';
import type { ContactAction } from './types';

const TIMELINE_PAGE = 50;
const CHANNEL_TYPES = ['email', 'phone', 'instagram', 'facebook', 'linkedin', 'other'] as const;
const TASK_TYPES = [['call', 'Call'], ['message', 'Message'], ['email', 'Email'], ['dm', 'DM'], ['online_meeting', 'Online meeting'], ['in_person_meeting', 'In-person meeting'], ['appointment', 'Appointment'], ['other', 'Other']] as const;

const copyToClipboard = (text: string) => { void navigator.clipboard?.writeText(text); };

/** One "Detailed Information" row: a round icon chip, a small grey label, the value and the row's copy button; `children` hold the row's own actions. */
function InfoRow({ icon, label, value, muted = false, children }: { icon?: React.ReactNode; label: string; value: string; muted?: boolean; children?: React.ReactNode }) {
  return (
    <li className="grid gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className={muted ? 'truncate text-muted-foreground' : 'truncate font-medium'}>{value}</div>
        </div>
        {!muted && <IconButton aria-label={`Copy ${label}`} tone="plain" onClick={() => copyToClipboard(value)}><Copy /></IconButton>}
      </div>
      {children}
    </li>
  );
}

/** A timeline entry's text; a planned entry adds its due time in the Building time zone. */
export function TimelineText({ entry, timeZone }: { entry: TimelineEntryDto; timeZone?: string }) {
  const dueAt = plannedDueAt(entry);
  return dueAt === null ? <>{entry.text}</> : <>{entry.text} for <RelativeTime at={dueAt} timeZone={timeZone} /></>;
}

/** The contact's detail, taking over the tab area: a profile card with round actions, the detailed information, what is waiting, and the interaction history. */
export function ContactPanel({ project, contactId, readOnly, focusAction, onChanged, onClose }: { project: { id: string }; contactId: number; readOnly: boolean; focusAction: ContactAction | null; onChanged: () => void; onClose: () => void }) {
  const projectId = project.id;
  const disabled = crmControlsDisabled(readOnly);
  const contact = useLoad(() => crmApi.contact(projectId, contactId), [projectId, contactId]);
  const [timelineLimit, setTimelineLimit] = useState(TIMELINE_PAGE);
  const timeline = useLoad(() => crmApi.timeline(projectId, contactId, timelineLimit, 0), [projectId, contactId, timelineLimit]);
  const settings = useLoad(() => crmApi.settings(projectId), [projectId]);
  const pending = useLoad(() => crmApi.followups(projectId, { contactId, state: 'pending', limit: 20 }), [projectId, contactId]);
  const merges = useLoad(() => crmApi.merges(projectId, contactId), [projectId, contactId]);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [reopenStage, setReopenStage] = useState('New');
  const [popup, setPopup] = useState<FollowupDto | null>(null);
  const [momFor, setMomFor] = useState<FollowupDto | null>(null);
  const [momMessage, setMomMessage] = useState<string | null>(null);
  const [open, setOpen] = useState<'response' | 'schedule' | null>(null);
  const [task, setTask] = useState<{ type: FollowupType; when: string; title: string }>({ type: 'call', when: '', title: '' });
  const [newChannel, setNewChannel] = useState<{ type: ChannelType; handle: string }>({ type: 'email', handle: '' });
  const customerButton = useRef<HTMLButtonElement>(null);
  const lostButton = useRef<HTMLButtonElement>(null);
  const c = contact.data;

  // A contact dropped on the board's Customer or Lost zone opens with that action focused, ready to confirm.
  useEffect(() => {
    if (c && focusAction) (focusAction === 'customer' ? customerButton : lostButton).current?.focus();
  }, [c, focusAction]);

  const refresh = () => { contact.reload(); timeline.reload(); pending.reload(); merges.reload(); };
  const act = async (work: () => Promise<unknown>) => { setError(null); try { await work(); refresh(); onChanged(); } catch (e) { setError(errorText(e)); } };
  const counter = commentCounter(comment);
  const reasons = settings.data?.lostReasons ?? [];
  const reachable = (ch: ContactDto['channels'][number]) => !ch.invalid && !ch.dnc && !c?.dnc;
  const canMark = c && (c.segment === 'prospect' || c.segment === 'customer');

  return (
    <div className="grid gap-5 p-4 animate-in fade-in-0 sm:p-6" aria-label="Contact">
      <div className="flex items-start gap-3">
        <IconButton aria-label="Back to the list" onClick={onClose}><ArrowLeft /></IconButton>
        <PageHeader lines={[c ? contactLabel(c) : 'Contact']}>
          {c && <KpiRow items={[{ key: 'channels', label: 'Channels', value: c.channels.length }, { key: 'waiting', label: 'Waiting for you', value: pending.data?.total }, { key: 'history', label: 'Interactions', value: timeline.data?.total }]} icons={{ channels: <MessageSquare />, waiting: <CalendarPlus />, history: <Ellipsis /> }} />}
        </PageHeader>
      </div>
      <ErrorNote message={error ?? contact.error} />
      {momMessage && <p className="m-0 text-sm text-success-foreground" role="status">{momMessage}</p>}
      {!c && contact.loading && <p className="m-0 text-sm text-muted-foreground">Loading…</p>}
      {c && (
        <>
          <section className="flex flex-wrap items-center gap-5 rounded-card bg-card p-6 shadow-soft" aria-label="Profile">
            <ScoreRing value={profileCompleteness(c)} label={`Profile completeness of ${contactLabel(c)}`}>{initials(c.name ?? contactLabel(c))}</ScoreRing>
            <div className="grid min-w-0 flex-1 gap-2">
              <div>
                <h3 className="m-0 truncate text-xl font-semibold">{contactLabel(c)}</h3>
                <p className="m-0 text-sm text-muted-foreground">{roleLine(c)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="success">{SEGMENT_LABEL[c.segment]}{c.stage ? ` / ${c.stage}` : ''}</Badge>
                {c.tags.map((t) => <Badge key={t} variant="secondary">tag: {t}</Badge>)}
                <Badge variant="secondary">source: {c.source}</Badge>
                {c.noResponse && <Badge variant="warning">No response</Badge>}
                {c.dnc && <Badge variant="soft-destructive">Do not contact</Badge>}
              </div>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Contact actions">
                {c.segment === 'prospect' && (
                  <>
                    <IconButton ref={customerButton} aria-label="Mark as customer" title={disabledTitle(readOnly, 'Mark as customer')} disabled={disabled} onClick={() => void act(async () => { await crmApi.markCustomer(projectId, c.id); })}><UserCheck /></IconButton>
                    <IconButton aria-label="Log a response" aria-pressed={open === 'response'} disabled={disabled} onClick={() => setOpen((o) => (o === 'response' ? null : 'response'))}><MessageSquare /></IconButton>
                  </>
                )}
                {canMark && (
                  <>
                    <IconButton aria-label="Schedule a followup" aria-pressed={open === 'schedule'} disabled={disabled} onClick={() => setOpen((o) => (o === 'schedule' ? null : 'schedule'))}><CalendarPlus /></IconButton>
                    <IconButton ref={lostButton} aria-label="Mark lost" title={disabledTitle(readOnly, 'Mark lost')} disabled={disabled || reasons.length === 0} onClick={() => void act(() => crmApi.markLost(projectId, c.id, lostReason || reasons[0]!))}><UserX /></IconButton>
                    <NativeSelect aria-label="Lost reason" value={lostReason || reasons[0] || ''} disabled={disabled} onChange={(e) => setLostReason(e.target.value)}>{reasons.map((r) => <option key={r}>{r}</option>)}</NativeSelect>
                  </>
                )}
                <IconButton aria-label="Do not contact (whole contact)" aria-pressed={c.dnc} disabled={disabled} onClick={() => void act(() => crmApi.setDnc(projectId, c.id, !c.dnc))}><Ban /></IconButton>
                {c.segment === 'prospect' && (
                  <NativeSelect aria-label="Stage" value={c.stage ?? 'New'} disabled={disabled} onChange={(e) => void act(() => crmApi.setStage(projectId, c.id, e.target.value as Stage))}>{BOARD_STAGES.map((s) => <option key={s}>{s}</option>)}</NativeSelect>
                )}
                {c.segment.startsWith('lost') && (
                  <>
                    {c.segment === 'lost_prospect' && <NativeSelect aria-label="Stage to reopen at" value={reopenStage} disabled={disabled} onChange={(e) => setReopenStage(e.target.value)}>{REOPEN_STAGES.map((s) => <option key={s}>{s}</option>)}</NativeSelect>}
                    <Button disabled={disabled} title={disabledTitle(readOnly)} onClick={() => void act(() => crmApi.reopen(projectId, c.id, reopenStageParam(c.segment, reopenStage) as Stage | undefined))}>{reopenLabel(c.segment, reopenStage)}</Button>
                  </>
                )}
              </div>
            </div>
          </section>

          {pending.data && pending.data.rows.length > 0 && (
            <Section title="Waiting for you">
              <ul className="m-0 grid list-none gap-2 p-0 text-sm">
                {pending.data.rows.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-2 rounded-2xl bg-muted p-3"><span>{f.title} · {f.channelType ?? f.type}</span>
                    {isMessageType(f.type)
                      ? f.integrated
                        ? <span className="flex gap-2"><Button size="sm" disabled={disabled} onClick={() => void act(() => crmApi.approve(projectId, f.id))}>Approve</Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => void act(() => crmApi.reject(projectId, f.id))}>Reject</Button></span>
                        : <Button size="sm" variant="outline" disabled={disabled} onClick={() => setPopup(f)}>Pending reachout</Button>
                      : <span className="flex gap-2">
                        {canMarkDone(f) && <Button size="sm" disabled={disabled} title={disabledTitle(readOnly)} onClick={() => void act(() => crmApi.complete(projectId, f.id))}>Mark done</Button>}
                        <Button size="sm" variant="outline" disabled={disabled} title={disabledTitle(readOnly)} onClick={() => setMomFor(f)}>Notes</Button>
                      </span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {open === 'response' && c.segment === 'prospect' && settings.data && (
            <Section title="Log a response"><ResponseForm projectId={projectId} contactId={c.id} channels={c.channels} lostReasons={reasons} readOnly={readOnly} onLogged={refresh} /></Section>
          )}

          {open === 'schedule' && canMark && (
            <Section title="Schedule a followup, call or meeting">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <NativeSelect aria-label="Type" value={task.type} disabled={disabled} onChange={(e) => setTask({ ...task, type: e.target.value as FollowupType })}>
                  {TASK_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </NativeSelect>
                <Input aria-label="When" type="datetime-local" className="w-56" value={task.when} disabled={disabled} onChange={(e) => setTask({ ...task, when: e.target.value })} />
                <Input aria-label="Title" placeholder="Title (optional)" className="w-48" value={task.title} disabled={disabled} onChange={(e) => setTask({ ...task, title: e.target.value })} />
                <Button disabled={disabled || !task.when} title={disabledTitle(readOnly)} onClick={() => void act(async () => { await crmApi.createFollowup(projectId, c.id, { type: task.type, dueAt: new Date(task.when).toISOString(), ...(task.title.trim() ? { title: task.title.trim() } : {}) }); setTask({ ...task, when: '', title: '' }); })}>Schedule</Button>
              </div>
            </Section>
          )}

          <Section title="Detailed Information">
            <ul className="m-0 grid list-none divide-y divide-border p-0 text-sm" aria-label="Channels and fields">
              {c.channels.map((ch) => (
                <InfoRow key={ch.id} icon={<ChannelIcon type={ch.type} className="size-4" />} label={`${ch.type}${ch.label ? ` (${ch.label})` : ''}`} value={ch.handle}>
                  <div className="ml-12 flex flex-wrap items-center gap-2">
                    {channelBadges(ch).map((b) => <Badge key={b} variant={b === 'Valid' ? 'success' : 'soft-destructive'}>{b}</Badge>)}
                    <Button size="sm" variant="outline" disabled={disabled} onClick={() => void act(() => crmApi.patchChannel(projectId, c.id, ch.id, { invalid: !ch.invalid }))}>{ch.invalid ? 'Mark valid' : 'Mark invalid'}</Button>
                    <Button size="sm" variant="outline" disabled={disabled} onClick={() => void act(() => crmApi.patchChannel(projectId, c.id, ch.id, { dnc: !ch.dnc }))}>{ch.dnc ? 'Allow contact' : 'Do not contact'}</Button>
                    {c.segment === 'prospect' && <Button size="sm" disabled={disabled || !reachable(ch)} title={disabledTitle(readOnly)} onClick={() => void act(() => crmApi.reachout(projectId, c.id, { channelId: ch.id }))}>Start reachout</Button>}
                    <IconButton aria-label={`Remove ${ch.handle}`} tone="plain" disabled={disabled} onClick={() => void act(() => crmApi.removeChannel(projectId, c.id, ch.id))}><Trash2 /></IconButton>
                  </div>
                </InfoRow>
              ))}
              {detailRows(c, settings.data?.customFields ?? []).map((row) => <InfoRow key={row.key} label={row.label} value={row.value} muted={row.empty} />)}
            </ul>
            {(settings.data?.customFields.length ?? 0) === 0 && <p className="m-0 mt-3 text-sm text-muted-foreground">No custom fields are defined. Add them in Settings.</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <NativeSelect aria-label="New channel type" value={newChannel.type} disabled={disabled} onChange={(e) => setNewChannel({ ...newChannel, type: e.target.value as ChannelType })}>{CHANNEL_TYPES.map((t) => <option key={t}>{t}</option>)}</NativeSelect>
              <Input aria-label="New channel handle" className="w-56" value={newChannel.handle} disabled={disabled} onChange={(e) => setNewChannel({ ...newChannel, handle: e.target.value })} />
              <Button disabled={disabled || !newChannel.handle.trim()} onClick={() => void act(async () => { await crmApi.addChannel(projectId, c.id, { type: newChannel.type, label: newChannel.type === 'other' ? 'other' : undefined, handle: newChannel.handle }); setNewChannel({ ...newChannel, handle: '' }); })}>Add channel</Button>
            </div>
          </Section>

          {merges.data && merges.data.filter((m) => !m.undone && m.survivorId === c.id).map((m) => (
            <Section key={m.id} title={`Merged with contact ${m.absorbedId}`}>
              <Button variant="outline" disabled={disabled} onClick={() => void act(async () => { try { await crmApi.undoMerge(projectId, m.id); } catch (e) { throw new Error(undoRefusal({ message: errorText(e), details: (e as { details?: Record<string, unknown> }).details })); } })}>Undo merge</Button>
            </Section>
          ))}

          <Section title="Interaction History">
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Textarea aria-label="Comment" placeholder="Add a comment or note" value={comment} disabled={disabled} onChange={(e) => setComment(e.target.value)} />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className={counter.over ? 'text-destructive' : ''}>{counter.count} / 5,000</span>
                  <Button size="sm" disabled={disabled || !counter.canSend} title={disabledTitle(readOnly)} onClick={() => void act(async () => { await crmApi.addComment(projectId, c.id, comment); setComment(''); })}>Add</Button>
                </div>
              </div>
              <ol className="m-0 grid list-none gap-3 p-0 text-sm md:grid-cols-2">
                {timelineNewestFirst(timeline.data?.rows ?? []).map((e) => (
                  <li key={e.id}>
                    <ItemCard
                      accent={timelineAccent(e.kind)}
                      topLine={<><RelativeTime at={e.at} timeZone={settings.data?.timezone} />{e.editedAt ? ' · edited' : ''}</>}
                      title={e.kind === 'building_work' ? 'Building work' : e.kind.replace(/_/g, ' ')}
                      menu={e.kind === 'comment' && !e.deleted ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><IconButton aria-label="Comment actions" tone="glass" className="size-7" disabled={disabled}><Ellipsis /></IconButton></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setEditing({ id: e.id, text: e.text })}>Edit</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void act(() => crmApi.deleteComment(projectId, c.id, e.id))}>Delete</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : undefined}
                    >
                      {editing?.id === e.id ? (
                        <div className="grid gap-2 text-foreground">
                          <Textarea aria-label="Edit comment" value={editing.text} onChange={(ev) => setEditing({ id: e.id, text: ev.target.value })} />
                          <span className="flex gap-2"><Button size="sm" disabled={!commentCounter(editing.text).canSend} onClick={() => void act(async () => { await crmApi.editComment(projectId, c.id, e.id, editing.text); setEditing(null); })}>Save</Button><Button size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button></span>
                        </div>
                      ) : e.kind === 'building_work' ? (
                        <WorkEntryBody entry={e} />
                      ) : (
                        <p className="m-0 whitespace-pre-wrap">{e.deleted ? <em className="opacity-75">Comment deleted</em> : <TimelineText entry={e} timeZone={settings.data?.timezone} />}</p>
                      )}
                    </ItemCard>
                  </li>
                ))}
              </ol>
              {timeline.data?.hasMore && <Button variant="outline" className="justify-self-center" onClick={() => setTimelineLimit((n) => n + TIMELINE_PAGE)}>Show older</Button>}
            </div>
          </Section>
        </>
      )}
      {momFor && <MomDialog projectId={projectId} item={momFor} contactLabel={itemContactLabel(momFor)} readOnly={readOnly} onSaved={setMomMessage} onError={setError} onClose={() => setMomFor(null)} />}
      {popup && settings.data && <ReachoutPopup projectId={projectId} item={popup} retry={settings.data.cadence} timezone={settings.data.timezone} readOnly={readOnly} onClose={() => setPopup(null)} onDone={() => { setPopup(null); refresh(); }} />}
    </div>
  );
}
