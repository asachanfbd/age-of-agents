import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { SESSIONS_KEEP_ACCOUNT_NOTE, accountOptions, canRecheck, cardResult, ghProblem, showsAccountCard } from '../../lib/githubAccounts';
import { useWorldStore } from '../../store/worldStore';
import type { ProjectData } from '../../types';

const TONE_CLASS = {
  neutral: 'text-muted-foreground',
  good: 'text-success-foreground',
  warning: 'text-warning-foreground',
  bad: 'text-destructive',
} as const;

/** Project settings → Git provider → GitHub account: which `gh` account this project's GitHub operations and agent sessions run as. */
export function GithubAccountCard({ project }: { project: ProjectData }) {
  const result = useWorldStore((s) => s.githubAccounts);
  const check = useWorldStore((s) => s.githubAccountChecks[project.id] ?? null);
  const load = useWorldStore((s) => s.loadGithubAccounts);
  const setAccount = useWorldStore((s) => s.setProjectGithubAccount);
  const recheck = useWorldStore((s) => s.checkProjectGithubAccount);
  const visible = showsAccountCard(project);

  useEffect(() => { if (visible) void load(); }, [visible, load]);
  useEffect(() => { if (visible && project.githubAccount) void recheck(project.id); }, [visible, project.id, project.githubAccount, recheck]);

  if (!visible) return null;
  const problem = ghProblem(result?.gh, result?.minGhVersion);
  const view = cardResult(project, check);
  return (
    <section className="mt-6 rounded-xl border bg-card p-4 text-card-foreground shadow-sm" aria-label="GitHub account">
      <h4 className="text-sm font-semibold">GitHub account</h4>
      <p className="mt-0.5 text-sm text-muted-foreground">Pushes, commit authors, pull requests and agent sessions for this project use this account. Your machine default is never changed.</p>
      {problem && <p role="alert" className="mt-3 text-sm">{problem}</p>}
      <div className="mt-3 flex items-center gap-2">
        <select
          aria-label="GitHub account"
          className="h-9 min-w-48 rounded-md border bg-background px-2 text-sm"
          value={project.githubAccount ?? ''}
          onChange={(event) => void setAccount(project.id, event.target.value || null)}
        >
          {accountOptions(project, result).map((option) => (
            <option key={option.value || 'default'} value={option.value} disabled={option.disabled && option.value !== (project.githubAccount ?? '')}>{option.label}</option>
          ))}
        </select>
        <Button type="button" variant="outline" size="sm" disabled={!canRecheck(project, result) || check === 'checking'} onClick={() => void recheck(project.id)}>Re-check</Button>
      </div>
      <p className={`mt-3 text-sm ${TONE_CLASS[view.tone]}`} role={view.blocks ? 'alert' : 'status'}>{view.text}</p>
      <p className="mt-2 text-xs text-muted-foreground">{SESSIONS_KEEP_ACCOUNT_NOTE}</p>
    </section>
  );
}
