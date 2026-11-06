import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { accountStatusLabel, ghProblem, identityDraftError, usedByLabel } from '../lib/githubAccounts';
import type { GithubAccount } from '../lib/githubAccounts';
import { useWorldStore } from '../store/worldStore';
import { CopyButton } from './CopyButton';

/** Global Settings → GitHub accounts: the accounts the machine's `gh` is signed in to, and the commit identity used for each. */
export function GithubAccountsSettings() {
  const result = useWorldStore((s) => s.githubAccounts);
  const loading = useWorldStore((s) => s.githubAccountsLoading);
  const load = useWorldStore((s) => s.loadGithubAccounts);

  useEffect(() => { void load(); }, [load]);

  const problem = ghProblem(result?.gh, result?.minGhVersion);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">Accounts come from the GitHub CLI on this machine. Each project can use one of them for pushes, commits, pull requests and its agent sessions. Nothing here changes your machine-wide git or gh settings.</p>
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>
      {problem && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">{problem}</p>}
      {!problem && result && result.accounts.length === 0 && <p className="text-sm italic text-muted-foreground">No accounts are signed in to gh for github.com.</p>}
      <ul className="space-y-3" aria-label="GitHub accounts">
        {result?.accounts.map((account) => <AccountCard key={account.login} account={account} />)}
      </ul>
      <div className="rounded-lg border border-dashed p-3 text-sm">
        <p className="font-medium">Add another account</p>
        <p className="mt-1 text-muted-foreground">Sign in once with the GitHub CLI, then press Refresh.</p>
        <div className="mt-2 flex items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 text-xs">{result?.addCommand ?? 'gh auth login -h github.com'}</code>
          <CopyButton text={result?.addCommand ?? 'gh auth login -h github.com'} label="Copy sign-in command" />
        </div>
      </div>
    </div>
  );
}

function AccountCard({ account }: { account: GithubAccount }) {
  const save = useWorldStore((s) => s.saveGithubIdentity);
  const reset = useWorldStore((s) => s.resetGithubIdentity);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.identity);
  const error = editing ? identityDraftError(draft) : null;

  async function submit() {
    if (await save(account.login, draft)) setEditing(false);
  }

  return (
    <li className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-sm font-semibold">{account.login}</span>
          {account.name && <span className="ml-2 text-sm text-muted-foreground">{account.name}</span>}
        </div>
        <div className="flex items-center gap-2">
          {account.active && <Badge variant="outline">gh active</Badge>}
          <Badge variant={account.signedIn ? 'secondary' : 'destructive'}>{accountStatusLabel(account)}</Badge>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{usedByLabel(account.usedByProjects)}</p>
      {!account.signedIn && <p className="mt-2 text-sm">Sign in again with <code>gh auth login -h github.com</code>.</p>}
      {editing ? (
        <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); if (!error) void submit(); }}>
          <label className="block text-xs font-medium">Commit author name
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} aria-label={`Commit author name for ${account.login}`} />
          </label>
          <label className="block text-xs font-medium">Commit email
            <Input value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} aria-label={`Commit email for ${account.login}`} />
          </label>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={Boolean(error)}>Save</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft(account.identity); setEditing(false); }}>Cancel</Button>
            {account.hasCustomIdentity && <Button type="button" size="sm" variant="ghost" onClick={() => void reset(account.login).then((ok) => { if (ok) setEditing(false); })}>Reset to defaults</Button>}
          </div>
        </form>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-3 text-sm">
          <span>Commits as <strong>{account.identity.name}</strong> &lt;{account.identity.email}&gt;{account.hasCustomIdentity ? '' : ' (default)'}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => { setDraft(account.identity); setEditing(true); }}>Edit</Button>
        </div>
      )}
    </li>
  );
}
