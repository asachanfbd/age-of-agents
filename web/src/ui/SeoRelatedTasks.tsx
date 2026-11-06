import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { serverApi } from '../lib/serverApi';
import { GROUP_LABEL, GROUP_TONE, overdueText } from '../lib/seoTasks';
import type { LinkType, NewTaskDraft, TaskRowDto } from '../lib/seoTasks';
import { NewTaskDialog } from './SeoTaskDialogs';

/** "Tasks related to this item" on a drill-down, with a Create task shortcut prefilled for the item. */
export function RelatedTasks({ projectId, type, itemRef, draft, readOnly }: { projectId: string; type: LinkType; itemRef: string; draft: NewTaskDraft; readOnly: boolean }) {
  const [tasks, setTasks] = useState<TaskRowDto[] | null>(null);
  const [inData, setInData] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    serverApi.seoRelatedTasks(projectId, type, itemRef).then((r) => { setTasks(r.tasks); setInData(r.inData); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : 'Could not load tasks'));
  }, [projectId, type, itemRef]);
  useEffect(() => { setTasks(null); load(); }, [load]);
  return (
    <section className="mt-4" aria-label="Related tasks">
      <div className="flex items-center justify-between">
        <h5 className="m-0 text-xs font-semibold uppercase text-muted-foreground">Tasks related to this {type}</h5>
        <Button size="sm" variant="outline" disabled={readOnly} onClick={() => setCreating(true)}>Create task</Button>
      </div>
      {!inData && tasks && tasks.length > 0 && <span className="mt-1 inline-block rounded bg-muted px-1 text-xs">no longer in data</span>}
      {error && <p role="alert" className="m-0 text-destructive">{error}</p>}
      {tasks && tasks.length === 0 && <p className="m-0 mt-1 text-muted-foreground">No tasks yet.</p>}
      <ul className="m-0 mt-1 grid gap-1 p-0">
        {tasks?.map((t) => <li key={t.id} className="list-none"><span className={GROUP_TONE[t.group]}>{GROUP_LABEL[t.group]}</span> {t.title}{overdueText(t) && <span className="ml-1 text-destructive">{overdueText(t)}</span>}</li>)}
      </ul>
      {creating && <NewTaskDialog projectId={projectId} initial={draft} onClose={() => setCreating(false)} onSaved={load} />}
    </section>
  );
}
