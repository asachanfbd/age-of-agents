import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown, GitBranch, GitBranchPlus, RefreshCw, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { describeSync, describeSyncBlocking, isOutOfSync } from '../../lib/gitSync';
import { isProjectFolderBusy } from '../../lib/branchMenu';
import { EMPTY_PR_ACTIONS, returnMenuItem } from '../../lib/pullRequestActions';
import { serverApi, type WorkflowRunRecord } from '../../lib/serverApi';
import { useWorldStore } from '../../store/worldStore';
import type { TaskData, ProjectData } from '../../types';

const EMPTY_TASK_IDS: string[] = [];
const EMPTY_RUNS: WorkflowRunRecord[] = [];

/**
 * The header's branch switcher. Its search field does two jobs: it filters the branches, and when the
 * text matches none exactly it offers to create that branch. Picking a branch checks it out (a
 * remote-only name is auto-tracked server-side). A final item catches the branch up to its remote —
 * it starts a real command run, whose log `onOpenCommandLog` shows. Sync and switching to an existing
 * branch are disabled only while something is really working in the Project's own folder — a
 * coding Task or WorkflowRun with no worktree of its own (`isProjectFolderBusy`, the same rule the
 * daemon refuses on). A planning session, or work isolated in its own worktree, never disables them;
 * creating a branch always stays available regardless, since it carries any in-progress work over
 * (see the server's `checkoutProjectBranch`), for when work was started on main/develop by mistake.
 * While the folder is on a pull request's branch through the PR tab's Check out, the list starts with
 * "Return to <previous branch>" (`returnMenuItem`), which stays after that PR is merged and gone.
 */
export function BranchMenu({ project, onOpenCommandLog }: { project: ProjectData; onOpenCommandLog: (runId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<{ current: string; branches: string[] } | null>(null);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const loadPlan = useWorldStore((s) => s.loadPlan);
  const syncProjectBranch = useWorldStore((s) => s.syncProjectBranch);
  const taskIds = useWorldStore((s) => s.taskIdsByProject[project.id]) ?? EMPTY_TASK_IDS;
  const tasksById = useWorldStore((s) => s.tasksById);
  const runs = useWorldStore((s) => s.workflowRunsByProject[project.id]) ?? EMPTY_RUNS;
  const tasks = taskIds.map((id) => tasksById[id]).filter((task): task is TaskData => !!task);
  const returnFromPullRequest = useWorldStore((s) => s.returnFromPullRequest);
  const prActions = useWorldStore((s) => s.prActionsByProject[project.id]) ?? EMPTY_PR_ACTIONS;
  const busy = isProjectFolderBusy(tasks, runs);
  const outOfSync = isOutOfSync(project.sync);
  const syncedBranch = project.sync?.branch ?? null;

  // Loaded up front so the trigger shows the real branch name right away; until it resolves it falls back to the poller's last reading.
  // Read again whenever the checked-out branch changes elsewhere (the PR tab's Check out and Return).
  useEffect(() => {
    let active = true;
    serverApi.projectBranches(project.id).then((next) => { if (active) setInfo(next); }).catch(() => {});
    return () => { active = false; };
  }, [project.id, syncedBranch]);

  const displayBranch = info?.current ?? syncedBranch;
  const returnItem = returnMenuItem(project.prCheckout, displayBranch, prActions.returnError);

  async function goBack(branch?: string) {
    if (busy || pending) return;
    setPending(true);
    const returned = await returnFromPullRequest(project.id, branch);
    setPending(false);
    if (returned) setOpen(false);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    setError('');
    if (!next) {
      setQuery('');
      return;
    }
    serverApi.projectBranches(project.id).then(setInfo).catch((failure) => setError((failure as Error).message));
  }

  async function checkout(branch: string, create: boolean) {
    const name = branch.trim();
    if ((busy && !create) || pending || !name) return;
    setPending(true);
    setError('');
    try {
      setInfo(await serverApi.checkoutBranch(project.id, name, create));
      setQuery('');
      setOpen(false);
      await loadPlan(project.id);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function sync() {
    setPending(true);
    const run = await syncProjectBranch(project.id);
    setPending(false);
    if (run) {
      setOpen(false);
      onOpenCommandLog(run.id);
    }
  }

  const trimmed = query.trim();
  const matches = info?.branches.filter((branch) => !trimmed || branch.toLowerCase().includes(trimmed.toLowerCase())) ?? [];
  const exactMatch = !!info?.branches.includes(trimmed);
  const syncBlocking = describeSyncBlocking(project.sync, project.name);

  // `modal`: this menu is portalled outside the popup dialog, whose scroll lock would otherwise swallow
  // wheel scrolling in the branch list.
  return (
    <Popover modal open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          title={busy ? "Work is running in this project's own folder: you can create a new branch to carry it over" : `Current branch: ${displayBranch ?? project.name}`}
        >
          <GitBranch aria-hidden="true" />
          <span className={`max-w-32 truncate ${!info && displayBranch ? 'text-muted-foreground' : ''}`}>{displayBranch ?? '…'}</span>
          {outOfSync && <span className="size-1.5 rounded-full bg-destructive" aria-label="Behind its remote" />}
          <ChevronsUpDown className="!size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <Command shouldFilter={false}>
          <CommandInput placeholder={busy ? 'Create branch...' : 'Search or create branch...'} value={query} onValueChange={setQuery} />
          <div className="flex items-center justify-between px-3 pt-2 pb-1">
            <span className="text-xs font-medium text-muted-foreground">Branches</span>
            <button
              type="button"
              className={`flex items-center gap-1 rounded-sm text-xs outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 ${outOfSync ? 'text-destructive hover:text-destructive' : 'text-muted-foreground'}`}
              title={describeSync(project.sync)}
              disabled={pending || busy}
              onClick={() => void sync()}
            >
              <RefreshCw className={`size-3 ${pending ? 'animate-spin' : ''}`} aria-hidden="true" />
              Sync
            </button>
          </div>
          <CommandList>
            <CommandEmpty>{info ? 'No branches found.' : 'Loading…'}</CommandEmpty>
            {returnItem && (
              <CommandGroup>
                <CommandItem value={`__return__${returnItem.label}`} disabled={pending || busy} onSelect={() => void goBack(returnItem.branch)}>
                  <Undo2 className="text-muted-foreground" />
                  <span className="truncate">{returnItem.label}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {matches.length > 0 && (
              <CommandGroup>
                {matches.map((branch) => (
                  <CommandItem key={branch} value={branch} disabled={pending || busy} onSelect={() => void checkout(branch, false)}>
                    <GitBranch className="text-muted-foreground" />
                    <span className="truncate">{branch}</span>
                    {branch === info?.current && <Check className="ml-auto" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {trimmed && !exactMatch && (
              <CommandGroup>
                <CommandItem value={`__create__${trimmed}`} disabled={pending} onSelect={() => void checkout(trimmed, true)}>
                  <GitBranchPlus className="text-muted-foreground" />
                  <span className="truncate">Create branch <strong className="font-medium">{trimmed}</strong></span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
        {busy && <p className="border-t px-3 py-2 text-xs text-muted-foreground">Work is running in this project's own folder, so you can't switch branches or sync. Type a new name to create a branch; its uncommitted work moves onto it.</p>}
        {syncBlocking && (
          <div role="group" aria-labelledby="sync-blocking-title" className="flex flex-col gap-1 border-t px-3 py-2 text-xs">
            <p id="sync-blocking-title" className="font-semibold text-foreground">{syncBlocking.title}</p>
            <ul role="list" className="flex flex-col gap-0.5">
              {syncBlocking.files.map((file) => (
                <li key={file.path} className="flex items-baseline gap-1.5">
                  <code className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</code>
                  <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">{file.kindLabel}</span>
                </li>
              ))}
              {syncBlocking.moreText && <li className="italic text-muted-foreground">{syncBlocking.moreText}</li>}
            </ul>
            <p className="text-muted-foreground">{syncBlocking.hint}</p>
            <Button type="button" size="sm" variant="outline" className="w-fit" disabled={pending || busy} onClick={() => void sync()}>Check again</Button>
          </div>
        )}
        {returnItem?.explanation && <p role="alert" className="border-t px-3 py-2 text-sm text-destructive">{returnItem.explanation}</p>}
        {error && <p role="alert" className="border-t px-3 py-2 text-sm font-medium text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
