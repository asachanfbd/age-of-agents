import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { serverApi } from '../lib/serverApi';
import {
  boardColumns, DUE_LABEL, GROUP_LABEL, GROUP_TONE, GROUPS, hasFilters, LINK_TYPE_LABEL, listParams, MANUAL_STATUSES, NO_FILTERS, OWNER_LABEL, overdueText, SOURCE_LABEL,
} from '../lib/seoTasks';
import type { DueFilter, Group, LinkType, Owner, SourceKind, TaskDetailDto, TaskFilters, TaskListDto, TaskRowDto } from '../lib/seoTasks';
import { useWorldStore } from '../store/worldStore';
import type { ProjectData } from '../types';
import { SeoSchedules } from './SeoSchedules';
import { AgentTaskDialog, NewTaskDialog } from './SeoTaskDialogs';
import { ProposalReview } from './SeoProposalReview';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong');

function Drawer({ projectId, taskId, readOnly, onClose, onChanged }: { projectId: string; taskId: string; readOnly: boolean; onClose: () => void; onChanged: () => void }) {
  const [task, setTask] = useState<TaskDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const load = useCallback(() => { serverApi.seoTask(projectId, taskId).then((t) => { setTask(t); setError(null); }).catch((e) => setError(errorText(e))); }, [projectId, taskId]);
  useEffect(() => { setTask(null); load(); }, [load]);
  const act = async (work: () => Promise<unknown>, closeAfter = false) => { try { await work(); onChanged(); if (closeAfter) onClose(); else load(); } catch (e) { setError(errorText(e)); } };
  if (!task) return <aside className="w-[28rem] shrink-0 border-l p-4 text-sm" aria-label="Task detail">{error ?? 'Loading…'}</aside>;
  const manual = task.source === 'manual';
  return (
    <aside className="w-[28rem] shrink-0 overflow-y-auto border-l bg-card p-4 text-sm" aria-label="Task detail">
      <div className="flex items-start justify-between gap-2"><h4 className="m-0 break-words text-sm font-semibold">{task.title}</h4><Button size="sm" variant="ghost" onClick={onClose}>Close</Button></div>
      <p className="m-0 mt-1 text-xs text-muted-foreground">{SOURCE_LABEL[task.source]} · {task.subKind}{task.dueDate ? ` · due ${task.dueDate}` : ''}{overdueText(task) ? ` · ${overdueText(task)}` : ''}</p>
      {manual ? (
        <label className="mt-3 grid gap-1">Status
          <select aria-label="Status" className="h-9 rounded border bg-background px-2" disabled={readOnly} value={task.status} onChange={(e) => void act(() => serverApi.seoUpdateTask(projectId, task.id, { status: e.target.value }))}>
            {MANUAL_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
      ) : <p className="mt-3"><span className={GROUP_TONE[task.group]}>{task.statusLabel}</span>{task.statusNote ? ` — ${task.statusNote}` : ''} <span className="text-xs text-muted-foreground">(from its {task.source === 'agent' ? 'run' : 'schedule'})</span></p>}
      {task.notes && <p className="whitespace-pre-wrap">{task.notes}</p>}
      {task.resultNote && <p>{task.resultNote}</p>}
      {task.proposalError && <p role="alert" className="text-destructive">{task.proposalError}</p>}
      {task.evidence && task.evidence.length > 0 && <ul className="m-0 p-0">{task.evidence.map((e) => <li key={e} className="list-none break-all"><a className="underline" href={e} target="_blank" rel="noreferrer">{e}</a></li>)}</ul>}
      {task.links.length > 0 && <ul className="m-0 mt-2 p-0" aria-label="Linked items">{task.links.map((l) => (
        <li key={`${l.type}:${l.ref}`} className="list-none break-all">{LINK_TYPE_LABEL[l.type]}: {l.label}{l.inData === false && <span className="ml-1 rounded bg-muted px-1 text-xs">no longer in data</span>}</li>
      ))}</ul>}
      <div className="mt-3 flex flex-wrap gap-2">
        {task.runId && task.source === 'agent' && <Button size="sm" variant="outline" onClick={() => useWorldStore.getState().openWorkspaceCardDetail(projectId, { kind: 'run', id: task.runId! })}>Open on the global board</Button>}
        {task.source === 'agent' && task.group === 'running' && <Button size="sm" variant="outline" disabled={readOnly} onClick={() => void act(() => serverApi.seoStopAgentTask(projectId, task.id))}>Stop</Button>}
        {task.hasCsv && <a className="text-sm underline" href={serverApi.seoTaskCsvUrl(projectId, task.id)}>Download CSV</a>}
        {manual && !confirming && <Button size="sm" variant="outline" disabled={readOnly} onClick={() => setConfirming(true)}>Delete</Button>}
        {manual && confirming && <><Button size="sm" variant="destructive" onClick={() => void act(() => serverApi.seoDeleteTask(projectId, task.id), true)}>Yes, delete</Button><Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button></>}
      </div>
      {task.source === 'agent' && task.hasProposal && <div className="mt-4"><ProposalReview projectId={projectId} taskId={task.id} readOnly={readOnly} onChanged={() => { onChanged(); load(); }} /></div>}
      {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
    </aside>
  );
}

function RowCard({ task, selected, onOpen }: { task: TaskRowDto; selected: boolean; onOpen: () => void }) {
  return (
    <li className="list-none">
      <button type="button" onClick={onOpen} aria-current={selected ? 'true' : undefined}
        className={`flex w-full items-center gap-3 rounded border-l-4 px-3 py-2 text-left hover:bg-muted/50 ${task.overdue ? 'border-l-red-500 bg-destructive/5' : 'border-l-transparent'} ${selected ? 'bg-muted' : ''}`}>
        <span className="rounded bg-muted px-1.5 text-xs">{SOURCE_LABEL[task.source]}</span>
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        {overdueText(task) && <span className="rounded bg-destructive/15 px-1.5 text-xs text-destructive">{overdueText(task)}</span>}
        {task.dueDate && !task.overdue && <span className="text-xs text-muted-foreground">{task.dueDate}</span>}
        <span className={`text-xs ${GROUP_TONE[task.group]}`}>● {task.statusLabel}</span>
      </button>
    </li>
  );
}

const SELECT = 'h-8 rounded border bg-background px-2 text-sm';

/** The Tasks tab: manual, scheduled and agent tasks in one list or board, with Schedules as the second segment. */
export function SeoTasks({ project }: { project: ProjectData }) {
  const id = project.id;
  const readOnly = project.readOnly === true;
  const [segment, setSegment] = useState<'tasks' | 'schedules'>('tasks');
  const [view, setView] = useState<'list' | 'board'>('list');
  const [filters, setFilters] = useState<TaskFilters>(NO_FILTERS);
  const [data, setData] = useState<TaskListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'agent' | null>(null);
  const [hasCrawl, setHasCrawl] = useState(false);
  const load = useCallback(async () => {
    try { setData(await serverApi.seoTasks(id, listParams(filters))); setError(null); } catch (e) { setError(errorText(e)); }
  }, [id, filters]);
  useEffect(() => { const t = setTimeout(() => void load(), filters.search ? 250 : 0); return () => clearTimeout(t); }, [load, filters.search]);
  useEffect(() => { void serverApi.seoInternalLinks(id).then((o) => setHasCrawl(o.snapshots.length > 0)).catch(() => undefined); }, [id]);
  const set = <K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const columns = useMemo(() => boardColumns(data?.tasks ?? []), [data]);

  return (
    <div className="flex min-h-0 flex-1" aria-label="Tasks">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <Button size="sm" variant={segment === 'tasks' ? 'default' : 'outline'} onClick={() => setSegment('tasks')}>All tasks</Button>
          <Button size="sm" variant={segment === 'schedules' ? 'default' : 'outline'} onClick={() => setSegment('schedules')}>Schedules</Button>
          {segment === 'tasks' && <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setView(view === 'list' ? 'board' : 'list')}>{view === 'list' ? 'Board' : 'List'}</Button>
            <Button size="sm" variant="outline" disabled={readOnly} onClick={() => setDialog('agent')}>Run agent task</Button>
            <Button size="sm" disabled={readOnly} onClick={() => setDialog('new')}>New task</Button>
          </div>}
        </div>
        {segment === 'schedules' ? <div className="min-h-0 flex-1 overflow-y-auto"><SeoSchedules projectId={id} readOnly={readOnly} onChanged={() => void load()} /></div> : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Filters">
              <Input aria-label="Search tasks" className="h-8 w-48" placeholder="Search" value={filters.search} onChange={(e) => set('search', e.target.value)} />
              <select aria-label="Kind" className={SELECT} value={filters.kind} onChange={(e) => set('kind', e.target.value as SourceKind | '')}><option value="">All kinds</option>{Object.entries(SOURCE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <select aria-label="Owner" className={SELECT} value={filters.owner} onChange={(e) => set('owner', e.target.value as Owner | '')}><option value="">Any owner</option>{Object.entries(OWNER_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <select aria-label="Due" className={SELECT} value={filters.due} onChange={(e) => set('due', e.target.value as DueFilter | '')}><option value="">Any due date</option>{Object.entries(DUE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <select aria-label="Linked item" className={SELECT} value={filters.linkType} onChange={(e) => set('linkType', e.target.value as LinkType | '')}><option value="">Any linked item</option>{Object.entries(LINK_TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </div>
            <div className="mb-3 flex flex-wrap gap-2" aria-label="Status groups">
              {GROUPS.map((g: Group) => <Button key={g} size="sm" variant={filters.group === g ? 'default' : 'outline'} aria-pressed={filters.group === g} onClick={() => set('group', filters.group === g ? '' : g)}>{GROUP_LABEL[g]} {data?.counts[g] ?? 0}</Button>)}
            </div>
            {error && <p role="alert" className="text-destructive">{error} <button type="button" className="underline" onClick={() => void load()}>Retry</button></p>}
            {data && data.tasks.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">
              {hasFilters(filters) ? <>No tasks match these filters. <button type="button" className="underline" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button></> : 'No tasks yet. Create one, run an agent task, or add a schedule.'}
            </div>}
            {view === 'list' ? <ul className="m-0 grid gap-1 p-0">{data?.tasks.map((t) => <RowCard key={t.id} task={t} selected={t.id === openId} onOpen={() => setOpenId(t.id)} />)}</ul> : (
              <div className="grid grid-cols-5 gap-2" aria-label="Board">
                {columns.map((c) => <section key={c.group} className="min-w-0" aria-label={c.label}><h4 className={`m-0 mb-1 text-xs font-semibold uppercase ${GROUP_TONE[c.group]}`}>{c.label} {c.tasks.length}</h4>
                  <ul className="m-0 grid gap-1 p-0">{c.tasks.map((t) => <RowCard key={t.id} task={t} selected={t.id === openId} onOpen={() => setOpenId(t.id)} />)}</ul></section>)}
              </div>
            )}
          </div>
        )}
      </div>
      {segment === 'tasks' && openId && <Drawer key={openId} projectId={id} taskId={openId} readOnly={readOnly} onClose={() => setOpenId(null)} onChanged={() => void load()} />}
      {dialog === 'new' && <NewTaskDialog projectId={id} onClose={() => setDialog(null)} onSaved={() => void load()} />}
      {dialog === 'agent' && <AgentTaskDialog projectId={id} hasCrawl={hasCrawl} onClose={() => setDialog(null)} onStarted={() => void load()} />}
    </div>
  );
}
