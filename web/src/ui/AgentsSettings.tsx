import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useWorldStore } from '../store/worldStore';
import type { ExecutorInput, ExecutorProfile } from '../lib/serverApi';
import { formatEnvText, parseEnvText } from '../lib/executorEnv';
import { FormErrorAlert } from './FormErrorAlert';
import { useErrorScope } from './useErrorScope';

const KIND_LABELS: Record<ExecutorProfile['kind'], string> = {
  'claude-cli': 'Claude CLI',
  'codex-cli': 'Codex CLI',
};

/**
 * The add/edit form shared by "+ Add coding agent" and each row's "Edit" —
 * type (kind), the command/alias run to launch it, and its optional env
 * overrides (see server/executors.example.json for what those are for:
 * picking a specific logged-in account per executor).
 */
function ExecutorForm({
  initial,
  pending,
  onSave,
  onCancel,
}: {
  initial?: Pick<ExecutorProfile, 'label' | 'kind' | 'bin' | 'env'>;
  pending: boolean;
  onSave: (input: ExecutorInput) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [kind, setKind] = useState<ExecutorProfile['kind']>(initial?.kind ?? 'claude-cli');
  const [bin, setBin] = useState(initial?.bin ?? '');
  const [envText, setEnvText] = useState(initial ? formatEnvText(initial.env) : '');
  const canSave = label.trim() !== '' && bin.trim() !== '' && !pending;

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave({ label: label.trim(), kind, bin: bin.trim(), env: parseEnvText(envText) });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="executor-label">Display name</Label>
        <Input id="executor-label" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Display name" placeholder="Claude (work account)" disabled={pending} autoFocus />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="executor-kind">Type</Label>
        <Select value={kind} onValueChange={(value) => setKind(value as ExecutorProfile['kind'])} disabled={pending}>
          <SelectTrigger id="executor-kind" aria-label="Agent type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude-cli">Claude CLI</SelectItem>
            <SelectItem value="codex-cli">Codex CLI</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="executor-bin">Command (alias)</Label>
        <Input id="executor-bin" value={bin} onChange={(e) => setBin(e.target.value)} aria-label="Command or alias used to launch this agent" placeholder="claude" disabled={pending} />
        <p className="text-xs text-muted-foreground">The command run in the background to start this agent — a CLI binary name (<code>claude</code>, <code>codex</code>), or a shell alias pointing at a specific account.</p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="executor-env">Environment variables <span className="text-muted-foreground">(optional)</span></Label>
        <Textarea
          id="executor-env"
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          aria-label="Environment variables, one KEY=value per line"
          placeholder={'CLAUDE_CONFIG_DIR=/path/to/account'}
          rows={2}
          disabled={pending}
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" disabled={!canSave}>{pending ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}

/**
 * The "Coding agents" section of {@link SettingsPanel} — every way to launch a background coding
 * agent (docs: server/executors.example.json is the file this reads/writes on the daemon).
 * Add/edit/remove here reaches every other executor-aware view immediately, since they all read
 * the same `useWorldStore` executors list this section mutates.
 */
export function AgentsSettings() {
  const executors = useWorldStore((s) => s.executors);
  const addExecutor = useWorldStore((s) => s.addExecutor);
  const updateExecutor = useWorldStore((s) => s.updateExecutor);
  const deleteExecutor = useWorldStore((s) => s.deleteExecutor);
  const lastError = useErrorScope('agents');

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Which row (or "new") a save/remove is currently in flight for — disables just that row's controls.
  const [pendingId, setPendingId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-sm font-semibold">Coding agents</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Claude CLI and Codex CLI each open a live terminal inside the project popup. These are
          exactly what the agent picker offers.
        </p>
      </div>

      <FormErrorAlert message={lastError} />

      {executors.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">No coding agents configured yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {executors.map((executor) => (
            <li key={executor.id} className="rounded-lg border border-border bg-card p-3">
              {editingId === executor.id ? (
                <ExecutorForm
                  initial={executor}
                  pending={pendingId === executor.id}
                  onCancel={() => setEditingId(null)}
                  onSave={async (input) => {
                    setPendingId(executor.id);
                    const ok = await updateExecutor(executor.id, input);
                    setPendingId(null);
                    if (ok) setEditingId(null);
                  }}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant="outline">{KIND_LABELS[executor.kind]}</Badge>
                  <div className="flex min-w-40 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold">{executor.label}</span>
                    <span className="text-xs text-muted-foreground">
                      <code>{executor.bin}</code>
                      {Object.keys(executor.env).length > 0 && ` · ${Object.keys(executor.env).length} env var${Object.keys(executor.env).length > 1 ? 's' : ''}`}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditingId(executor.id)} disabled={pendingId === executor.id}>Edit</Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pendingId === executor.id}
                      onClick={async () => {
                        setPendingId(executor.id);
                        await deleteExecutor(executor.id);
                        setPendingId(null);
                      }}
                      aria-label={`Remove "${executor.label}"`}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border pt-5">
        {adding ? (
          <>
            <h3 className="mb-3 text-sm font-semibold">Add a coding agent</h3>
            <ExecutorForm
              pending={pendingId === 'new'}
              onCancel={() => setAdding(false)}
              onSave={async (input) => {
                setPendingId('new');
                const ok = await addExecutor(input);
                setPendingId(null);
                if (ok) setAdding(false);
              }}
            />
          </>
        ) : (
          <Button type="button" onClick={() => setAdding(true)}>+ Add coding agent</Button>
        )}
      </div>
    </div>
  );
}
