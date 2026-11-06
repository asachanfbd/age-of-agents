import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useWorldStore } from '../store/worldStore';
import type { Autonomy, CatalogAgent, CatalogSkill, ExecutorProfile, QuickLookKind, WorkflowRecord } from '../lib/serverApi';
import { QUICK_LOOK_OPTIONS } from '../lib/quickLook';
import {
  slugify,
  formatTriggers,
  isValidCatalogId,
  buildCreateCatalogAgentInput,
  buildUpdateCatalogAgentPatch,
  buildCreateCatalogSkillInput,
  buildUpdateCatalogSkillPatch,
} from '../lib/catalogForm';
import type { CatalogAgentFormFields, CatalogSkillFormFields } from '../lib/catalogForm';
import {
  DEFAULT_EXECUTOR_VALUE,
  addStep,
  agentOptionsFor,
  buildCreateWorkflowInput,
  buildUpdateWorkflowPatch,
  earlierSteps,
  emptyWorkflowFields,
  executorFieldValue,
  executorSelectValue,
  moveStep,
  removeStep,
  skillOptionsFor,
  withSkillPreload,
  withSkillSelected,
  validateWorkflowForm,
  workflowFieldsFromRecord,
} from '../lib/workflowForm';
import type { AgentConfigFields, StepFields, WorkflowFormFields } from '../lib/workflowForm';
import { BuildingTypesSettings } from './BuildingTypesSettings';
import { ConfirmDialog } from './project-popup/TaskDialogs';
import { FormErrorAlert } from './FormErrorAlert';
import { useErrorScope } from './useErrorScope';

const DEFAULT_WORKFLOW_ID = 'software-development';

/**
 * The Catalog modal — City Center's full CRUD surface for Templates (agents) and Skills, opened via
 * `openCatalog()`/`catalogOpen` (see `HomeBuilding.tsx`'s click handler) and closed via
 * `closeCatalog()`. A large, centered `Dialog` + top `Tabs`, matching `ProjectWorkspaceModal`'s
 * shell, and the same row-and-inline-form CRUD pattern as `AgentsSettings.tsx` — see the
 * `web-interaction-conventions` skill. Self-contained like `ProjectWorkspaceModal`: no props, reads
 * `catalogOpen` directly and renders nothing when closed, rather than being conditionally mounted by
 * a parent.
 *
 * Naming note: this is unrelated to `AgentsSettings.tsx`'s "coding agents" (which CLI/account runs a
 * Worker process) — that stays "Coding agents" in Settings; this is "Catalog" / "Agents" (Templates)
 * here, a completely different concept that happens to share the word "agent".
 */
type CatalogSection = 'agents' | 'skills' | 'workflows' | 'building-types';
const SECTIONS: { key: CatalogSection; label: string }[] = [
  { key: 'agents', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
  { key: 'workflows', label: 'Workflows' },
  { key: 'building-types', label: 'Building Types' },
];

export function CatalogModal() {
  const catalogOpen = useWorldStore((s) => s.catalogOpen);
  const closeCatalog = useWorldStore((s) => s.closeCatalog);
  const [section, setSection] = useState<CatalogSection>('agents');

  if (!catalogOpen) return null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) closeCatalog(); }}>
      <DialogContent className="flex h-[min(900px,var(--popup-max-height))] w-[min(1180px,96vw)] max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0" aria-label="Catalog">
        <DialogHeader className="border-b border-border px-6 py-4 text-left">
          <DialogTitle>Catalog</DialogTitle>
          <p className="text-xs text-muted-foreground">Templates and Skills a Task or Worker can be assigned — backed by this repo's own <code>catalog/</code> folder.</p>
        </DialogHeader>

        <Tabs value={section} onValueChange={(value) => setSection(value as CatalogSection)} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-6 mt-4 w-fit">
            {SECTIONS.map(({ key, label }) => <TabsTrigger key={key} value={key}>{label}</TabsTrigger>)}
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <TabsContent value="agents" className="mt-0">
              <AgentsTab />
            </TabsContent>
            <TabsContent value="skills" className="mt-0">
              <SkillsTab />
            </TabsContent>
            <TabsContent value="workflows" className="mt-0">
              <WorkflowsTab />
            </TabsContent>
            <TabsContent value="building-types" className="mt-0">
              <BuildingTypesSettings />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

const AUTONOMY_OPTIONS: { value: Autonomy; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'approval', label: 'Approval' },
];

/** Shared "start typing a name, get a slug in the Id field until you edit it yourself" wiring for both the agent and skill add/edit forms. */
function useSlugFollowingId(initialId: string | undefined) {
  const [id, setId] = useState(initialId ?? '');
  const [idTouched, setIdTouched] = useState(!!initialId);
  const onNameChange = (name: string, setName: (name: string) => void) => {
    setName(name);
    if (!idTouched) setId(slugify(name));
  };
  const onIdChange = (value: string) => {
    setId(value);
    setIdTouched(true);
  };
  return { id, onNameChange, onIdChange };
}

// ---------------------------------------------------------------------------------------------
// Agents tab
// ---------------------------------------------------------------------------------------------

function AgentForm({
  agent,
  pending,
  onCancel,
  onSave,
}: {
  agent?: CatalogAgent;
  pending: boolean;
  onCancel: () => void;
  onSave: (id: string, fields: CatalogAgentFormFields) => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const { id, onNameChange, onIdChange } = useSlugFollowingId(agent?.id);
  const [description, setDescription] = useState('');
  const [avatar, setAvatar] = useState(agent?.avatar ?? '');
  const [manager, setManager] = useState(agent?.manager ?? false);
  const [defaultAutonomy, setDefaultAutonomy] = useState<Autonomy>(agent?.defaultAutonomy ?? 'auto');
  const [body, setBody] = useState('');

  const idOk = agent ? true : isValidCatalogId(id);
  const canSave = name.trim() !== '' && idOk && (agent ? true : description.trim() !== '') && !pending;

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave(agent?.id ?? id, { name, description, avatar, manager, defaultAutonomy, body });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="agent-name">Name</Label>
        <Input id="agent-name" value={name} onChange={(e) => onNameChange(e.target.value, setName)} aria-label="Agent name" placeholder="Code Reviewer" disabled={pending} autoFocus />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="agent-id">Id</Label>
        <Input id="agent-id" value={agent?.id ?? id} onChange={(e) => onIdChange(e.target.value)} aria-label="Agent id" disabled={pending || !!agent} />
        {!agent && id.trim() !== '' && !idOk && (
          <Alert variant="destructive" role="alert"><AlertDescription>Id must start with a letter or digit, then only letters, digits, - or _.</AlertDescription></Alert>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="agent-description">
          Description{agent && <span className="text-muted-foreground"> (leave blank to keep the current description)</span>}
        </Label>
        <Textarea
          id="agent-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="Description"
          placeholder="What this agent is for"
          rows={2}
          disabled={pending}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="agent-avatar">Avatar (emoji)</Label>
        <Input id="agent-avatar" value={avatar} onChange={(e) => setAvatar(e.target.value)} aria-label="Avatar emoji" placeholder="🤖" disabled={pending} className="w-24" />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={manager} onCheckedChange={(checked) => setManager(checked === true)} disabled={pending} />
        Manager (delegates substantial sub-tasks to native sub-agents instead of doing all the work directly)
      </label>

      <div className="grid gap-1.5">
        <Label htmlFor="agent-autonomy">Default autonomy</Label>
        <Select value={defaultAutonomy} onValueChange={(value) => setDefaultAutonomy(value as Autonomy)} disabled={pending}>
          <SelectTrigger id="agent-autonomy" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {AUTONOMY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="agent-body">
          Persona (markdown body){agent && <span className="text-muted-foreground"> (leave blank to keep the current persona)</span>}
        </Label>
        <Textarea
          id="agent-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-label="Persona markdown body"
          placeholder={agent ? '' : 'You are a...'}
          rows={5}
          disabled={pending}
          className="font-mono text-xs"
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" disabled={!canSave}>{pending ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}

function AgentUploadForm({ pending, onUpload }: { pending: boolean; onUpload: (id: string, file: File) => void }) {
  const [id, setId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const canUpload = isValidCatalogId(id) && !!file && !pending;

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canUpload || !file) return;
        onUpload(id, file);
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="agent-upload-id">Id</Label>
        <Input id="agent-upload-id" value={id} onChange={(e) => setId(e.target.value)} aria-label="Agent id" placeholder="reviewer" disabled={pending} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="agent-upload-file">Agent markdown file (.md)</Label>
        <input id="agent-upload-file" type="file" accept=".md,text/markdown" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Agent markdown file" disabled={pending} className="text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground" />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={!canUpload}>{pending ? 'Uploading…' : 'Upload'}</Button>
      </div>
    </form>
  );
}

function AgentsTab() {
  const agents = useWorldStore((s) => s.catalogAgents);
  const createCatalogAgent = useWorldStore((s) => s.createCatalogAgent);
  const updateCatalogAgent = useWorldStore((s) => s.updateCatalogAgent);
  const deleteCatalogAgent = useWorldStore((s) => s.deleteCatalogAgent);
  const toggleCatalogAgentEnabled = useWorldStore((s) => s.toggleCatalogAgentEnabled);
  const uploadCatalogAgentFile = useWorldStore((s) => s.uploadCatalogAgentFile);
  const lastError = useErrorScope('catalog');

  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Which row (or 'new'/'upload') a save/remove/toggle is currently in flight for — disables just that row's controls.
  const [pendingId, setPendingId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-semibold">Agents</h3>
        <p className="mt-1 text-xs text-muted-foreground">Templates assignable to a Task or Worker — a persona plus a default autonomy.</p>
      </div>

      <FormErrorAlert message={lastError} />

      {agents.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">No agents yet. Add one below.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {agents.map((agent) => (
            <li key={agent.id} className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card p-3">
              {editingId === agent.id ? (
                <AgentForm
                  agent={agent}
                  pending={pendingId === agent.id}
                  onCancel={() => setEditingId(null)}
                  onSave={async (_id, fields) => {
                    setPendingId(agent.id);
                    const ok = await updateCatalogAgent(agent.id, buildUpdateCatalogAgentPatch(fields));
                    setPendingId(null);
                    if (ok) setEditingId(null);
                  }}
                />
              ) : (
                <>
                  <span className="flex-none text-xl leading-none" aria-hidden="true">{agent.avatar || '🤖'}</span>
                  <div className="flex min-w-40 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold">{agent.name}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={agent.enabled ? 'success' : 'secondary'}>{agent.enabled ? 'Enabled' : 'Disabled'}</Badge>
                      {agent.manager && <Badge variant="outline">Manager</Badge>}
                      <span className="text-xs text-muted-foreground">{agent.defaultAutonomy === 'auto' ? 'Auto' : 'Approval'}</span>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pendingId === agent.id}
                      onClick={async () => {
                        setPendingId(agent.id);
                        await toggleCatalogAgentEnabled(agent.id, !agent.enabled);
                        setPendingId(null);
                      }}
                    >
                      {agent.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditingId(agent.id)} disabled={pendingId === agent.id}>Edit</Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pendingId === agent.id}
                      onClick={async () => {
                        setPendingId(agent.id);
                        await deleteCatalogAgent(agent.id);
                        setPendingId(null);
                      }}
                      aria-label={`Remove "${agent.name}"`}
                    >
                      Remove
                    </Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-1 border-t border-border pt-4">
        {adding ? (
          <>
            <h3 className="mb-3 text-sm font-semibold">Add an agent</h3>
            <AgentForm
              pending={pendingId === 'new'}
              onCancel={() => setAdding(false)}
              onSave={async (id, fields) => {
                setPendingId('new');
                const ok = await createCatalogAgent(buildCreateCatalogAgentInput(id, fields));
                setPendingId(null);
                if (ok) setAdding(false);
              }}
            />
          </>
        ) : (
          <Button type="button" onClick={() => setAdding(true)}>+ Add agent</Button>
        )}
      </div>

      <div className="border-t border-border pt-4">
        {uploading ? (
          <>
            <h3 className="mb-3 text-sm font-semibold">Upload agent file</h3>
            <AgentUploadForm
              pending={pendingId === 'upload'}
              onUpload={async (id, file) => {
                setPendingId('upload');
                const ok = await uploadCatalogAgentFile({ id, file });
                setPendingId(null);
                if (ok) setUploading(false);
              }}
            />
          </>
        ) : (
          <Button type="button" variant="outline" onClick={() => setUploading(true)}>Upload .md file</Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Skills tab
// ---------------------------------------------------------------------------------------------

function SkillForm({
  skill,
  pending,
  onCancel,
  onSave,
}: {
  skill?: CatalogSkill;
  pending: boolean;
  onCancel: () => void;
  onSave: (id: string, fields: CatalogSkillFormFields) => void;
}) {
  const [name, setName] = useState(skill?.name ?? '');
  const { id, onNameChange, onIdChange } = useSlugFollowingId(skill?.id);
  const [description, setDescription] = useState(skill?.description ?? '');
  const [avatar, setAvatar] = useState(skill?.avatar ?? '');
  const [triggersText, setTriggersText] = useState(formatTriggers(skill?.triggers));
  const [body, setBody] = useState('');

  const idOk = skill ? true : isValidCatalogId(id);
  const canSave = name.trim() !== '' && idOk && description.trim() !== '' && !pending;

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave(skill?.id ?? id, { name, description, avatar, triggersText, body });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="skill-name">Name</Label>
        <Input id="skill-name" value={name} onChange={(e) => onNameChange(e.target.value, setName)} aria-label="Skill name" placeholder="Roadmap Runner" disabled={pending} autoFocus />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="skill-id">Id</Label>
        <Input id="skill-id" value={skill?.id ?? id} onChange={(e) => onIdChange(e.target.value)} aria-label="Skill id" disabled={pending || !!skill} />
        {!skill && id.trim() !== '' && !idOk && (
          <Alert variant="destructive" role="alert"><AlertDescription>Id must start with a letter or digit, then only letters, digits, - or _.</AlertDescription></Alert>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="skill-description">Description</Label>
        <Textarea id="skill-description" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" rows={2} disabled={pending} />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="skill-avatar">Avatar (emoji)</Label>
        <Input id="skill-avatar" value={avatar} onChange={(e) => setAvatar(e.target.value)} aria-label="Avatar emoji" placeholder="✨" disabled={pending} className="w-24" />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="skill-triggers">Triggers / commands <span className="text-muted-foreground">(one per line, or comma-separated)</span></Label>
        <Textarea
          id="skill-triggers"
          value={triggersText}
          onChange={(e) => setTriggersText(e.target.value)}
          aria-label="Triggers or commands"
          placeholder={'/deploy\nship it'}
          rows={2}
          disabled={pending}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="skill-body">
          SKILL.md body{skill && <span className="text-muted-foreground"> (leave blank to keep the current body)</span>}
        </Label>
        <Textarea
          id="skill-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-label="SKILL.md body"
          placeholder={skill ? '' : '# Instructions...'}
          rows={5}
          disabled={pending}
          className="font-mono text-xs"
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" disabled={!canSave}>{pending ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}

/** The edit-skill form's support-files sub-list (spec item 3) — only ever shown for a skill that already exists, since a support file attaches to an id the server already knows about. */
function SkillSupportFiles({
  skill,
  pending,
  onAdd,
  onRemove,
}: {
  skill: CatalogSkill;
  pending: boolean;
  onAdd: (name: string, file: File) => void;
  onRemove: (name: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Support files</h4>
      {skill.supportFiles.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">No support files.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {skill.supportFiles.map((name) => (
            <li key={name} className="flex items-center justify-between gap-2 text-sm">
              <span>{name}</span>
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => onRemove(name)} aria-label={`Remove file "${name}"`}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!file || pending) return;
          onAdd(file.name, file);
          setFile(null);
        }}
      >
        <input type="file" aria-label="Add support file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={pending} className="text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground" />
        <Button type="submit" variant="outline" size="sm" disabled={!file || pending}>Add file</Button>
      </form>
    </div>
  );
}

function SkillUploadForm({ pending, onUpload }: { pending: boolean; onUpload: (id: string, file: File) => void }) {
  const [id, setId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const canUpload = isValidCatalogId(id) && !!file && !pending;

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canUpload || !file) return;
        onUpload(id, file);
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="skill-upload-id">Id</Label>
        <Input id="skill-upload-id" value={id} onChange={(e) => setId(e.target.value)} aria-label="Skill id" placeholder="roadmap-runner" disabled={pending} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="skill-upload-file">Skill zip (SKILL.md at its root)</Label>
        <input id="skill-upload-file" type="file" accept=".zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Skill zip file" disabled={pending} className="text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground" />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={!canUpload}>{pending ? 'Uploading…' : 'Upload'}</Button>
      </div>
    </form>
  );
}

/** Maps a SkillInstallRun's status onto the `Badge` variant that reads the same way `AgentsTab`'s enabled/disabled pills do — 'running' as a neutral in-progress look (amber), 'success' as green, 'failed' as destructive. */
function installStatusBadgeVariant(status: 'running' | 'success' | 'failed'): 'warning' | 'success' | 'destructive' {
  if (status === 'running') return 'warning';
  if (status === 'success') return 'success';
  return 'destructive';
}

/**
 * "Install from registry" (spec item 4) — starts a real `npx skills add <owner/repo>` run and shows
 * its live progress. A successful settle already triggers `fetchCatalog()` itself
 * (`worldStore.ts`'s `connectLiveUpdates`, via `isSkillInstallSuccessEvent`), so this never refetches
 * on its own — the newly-installed skill just appears in the list above once that resolves.
 */
function SkillInstallSection() {
  const catalogInstallRuns = useWorldStore((s) => s.catalogInstallRuns);
  const startCatalogSkillInstall = useWorldStore((s) => s.startCatalogSkillInstall);
  const [repo, setRepo] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const run = runId ? catalogInstallRuns[runId] : undefined;

  return (
    <div className="flex flex-col gap-2.5 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">Install from registry</h3>
      <p className="text-xs text-muted-foreground">Runs <code>npx skills add &lt;owner/repo&gt;</code> in an isolated temp directory, then copies the result into this repo's <code>catalog/skills/</code>.</p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const trimmed = repo.trim();
          if (!trimmed || starting) return;
          setStarting(true);
          const started = await startCatalogSkillInstall(trimmed);
          setStarting(false);
          if (started) setRunId(started.id);
        }}
      >
        <Input value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="owner/repo" placeholder="owner/repo" disabled={starting} className="max-w-xs" />
        <Button type="submit" disabled={starting || !repo.trim()}>{starting ? 'Starting…' : 'Install'}</Button>
      </form>
      {run && (
        <div className="flex flex-col gap-2">
          <Badge variant={installStatusBadgeVariant(run.status)} className="w-fit">{run.status}</Badge>
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/60 p-3 font-mono text-xs">{run.output || 'Waiting for output…'}</pre>
        </div>
      )}
    </div>
  );
}

function SkillsTab() {
  const skills = useWorldStore((s) => s.catalogSkills);
  const createCatalogSkill = useWorldStore((s) => s.createCatalogSkill);
  const updateCatalogSkill = useWorldStore((s) => s.updateCatalogSkill);
  const deleteCatalogSkill = useWorldStore((s) => s.deleteCatalogSkill);
  const toggleCatalogSkillEnabled = useWorldStore((s) => s.toggleCatalogSkillEnabled);
  const uploadCatalogSkillZip = useWorldStore((s) => s.uploadCatalogSkillZip);
  const addCatalogSkillFile = useWorldStore((s) => s.addCatalogSkillFile);
  const removeCatalogSkillFile = useWorldStore((s) => s.removeCatalogSkillFile);
  const lastError = useErrorScope('catalog');

  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-semibold">Skills</h3>
        <p className="mt-1 text-xs text-muted-foreground">Reusable instructions a Task can be given alongside its Template.</p>
      </div>

      <FormErrorAlert message={lastError} />

      {skills.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">No skills yet. Add one below.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {skills.map((skill) => (
            <li key={skill.id} className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card p-3">
              {editingId === skill.id ? (
                <div className="flex w-full flex-col gap-3.5">
                  <SkillForm
                    skill={skill}
                    pending={pendingId === skill.id}
                    onCancel={() => setEditingId(null)}
                    onSave={async (_id, fields) => {
                      setPendingId(skill.id);
                      const ok = await updateCatalogSkill(skill.id, buildUpdateCatalogSkillPatch(fields));
                      setPendingId(null);
                      if (ok) setEditingId(null);
                    }}
                  />
                  <SkillSupportFiles
                    skill={skill}
                    pending={pendingId === skill.id}
                    onAdd={async (name, file) => {
                      setPendingId(skill.id);
                      await addCatalogSkillFile(skill.id, name, file);
                      setPendingId(null);
                    }}
                    onRemove={async (name) => {
                      setPendingId(skill.id);
                      await removeCatalogSkillFile(skill.id, name);
                      setPendingId(null);
                    }}
                  />
                </div>
              ) : (
                <>
                  <span className="flex-none text-xl leading-none" aria-hidden="true">{skill.avatar || '✨'}</span>
                  <div className="flex min-w-40 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold">{skill.name}</span>
                    {skill.triggers && skill.triggers.length > 0 && (
                      <span className="text-xs text-muted-foreground">Triggers: {skill.triggers.join(', ')}</span>
                    )}
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={skill.enabled ? 'success' : 'secondary'}>{skill.enabled ? 'Enabled' : 'Disabled'}</Badge>
                      {skill.supportFiles.length > 0 && (
                        <Badge variant="outline">{skill.supportFiles.length} file{skill.supportFiles.length > 1 ? 's' : ''}</Badge>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pendingId === skill.id}
                      onClick={async () => {
                        setPendingId(skill.id);
                        await toggleCatalogSkillEnabled(skill.id, !skill.enabled);
                        setPendingId(null);
                      }}
                    >
                      {skill.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditingId(skill.id)} disabled={pendingId === skill.id}>Edit</Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pendingId === skill.id}
                      onClick={async () => {
                        setPendingId(skill.id);
                        await deleteCatalogSkill(skill.id);
                        setPendingId(null);
                      }}
                      aria-label={`Remove "${skill.name}"`}
                    >
                      Remove
                    </Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-1 border-t border-border pt-4">
        {adding ? (
          <>
            <h3 className="mb-3 text-sm font-semibold">Add a skill</h3>
            <SkillForm
              pending={pendingId === 'new'}
              onCancel={() => setAdding(false)}
              onSave={async (id, fields) => {
                setPendingId('new');
                const ok = await createCatalogSkill(buildCreateCatalogSkillInput(id, fields));
                setPendingId(null);
                if (ok) setAdding(false);
              }}
            />
          </>
        ) : (
          <Button type="button" onClick={() => setAdding(true)}>+ Add skill</Button>
        )}
      </div>

      <div className="border-t border-border pt-4">
        {uploading ? (
          <>
            <h3 className="mb-3 text-sm font-semibold">Upload skill (.zip)</h3>
            <SkillUploadForm
              pending={pendingId === 'upload'}
              onUpload={async (id, file) => {
                setPendingId('upload');
                const ok = await uploadCatalogSkillZip({ id, file });
                setPendingId(null);
                if (ok) setUploading(false);
              }}
            />
          </>
        ) : (
          <Button type="button" variant="outline" onClick={() => setUploading(true)}>Upload skill (.zip)</Button>
        )}
      </div>

      <SkillInstallSection />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Workflows tab
// ---------------------------------------------------------------------------------------------

/** A step's agent/skills/executor-override/instructions block. */
function AgentConfigEditor({
  idPrefix,
  value,
  onChange,
  catalogAgents,
  catalogSkills,
  executors,
  pending,
}: {
  idPrefix: string;
  value: AgentConfigFields;
  onChange: (next: AgentConfigFields) => void;
  catalogAgents: CatalogAgent[];
  catalogSkills: CatalogSkill[];
  executors: ExecutorProfile[];
  pending: boolean;
}) {
  const agentOptions = agentOptionsFor(catalogAgents, value.agentId);
  const skillOptions = skillOptionsFor(catalogSkills, value.skillIds);

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-agent`}>Agent</Label>
        <Select value={value.agentId} onValueChange={(agentId) => onChange({ ...value, agentId })} disabled={pending}>
          <SelectTrigger id={`${idPrefix}-agent`}><SelectValue placeholder="Choose an agent" /></SelectTrigger>
          <SelectContent>
            {agentOptions.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>{agent.avatar ? `${agent.avatar} ` : ''}{agent.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label>Skills</Label>
        <p className="text-xs text-muted-foreground">Skills load on demand: the agent sees a short index and reads a SKILL.md only when it fits the work. Tick Always load to paste the full text every run.</p>
        {skillOptions.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">No skills available.</p>
        ) : (
          <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
            {skillOptions.map((skill) => {
              const selected = value.skillIds.includes(skill.id);
              return (
                <div key={skill.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <label className="flex min-w-0 flex-1 items-start gap-2 text-sm">
                    <Checkbox
                      checked={selected}
                      onCheckedChange={(checked) => onChange(withSkillSelected(value, skill.id, checked === true))}
                      disabled={pending}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      {skill.avatar ? `${skill.avatar} ` : ''}{skill.name}
                      <span className="block text-xs text-muted-foreground">{skill.description.trim() || '(no description)'}</span>
                    </span>
                  </label>
                  {selected && (
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Paste the full SKILL.md into the prompt every run">
                      <Checkbox
                        checked={value.preloadSkillIds.includes(skill.id)}
                        onCheckedChange={(checked) => onChange(withSkillPreload(value, skill.id, checked === true))}
                        disabled={pending}
                      />
                      Always load
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-executor`}>Executor override</Label>
        <Select value={executorSelectValue(value.executorId)} onValueChange={(v) => onChange({ ...value, executorId: executorFieldValue(v) })} disabled={pending}>
          <SelectTrigger id={`${idPrefix}-executor`} className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_EXECUTOR_VALUE}>Task&apos;s worker</SelectItem>
            {executors.map((executor) => <SelectItem key={executor.id} value={executor.id}>{executor.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-instructions`}>Instructions</Label>
        <Textarea
          id={`${idPrefix}-instructions`}
          value={value.instructions}
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
          rows={3}
          disabled={pending}
        />
      </div>
    </div>
  );
}

/** One row of the editable `steps` array — id/name (id locked once the step isn't new), the shared agent-config block, the two capability switches, and the loop-back control. */
function StepEditor({
  step,
  index,
  allSteps,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  catalogAgents,
  catalogSkills,
  executors,
  pending,
}: {
  step: StepFields;
  index: number;
  allSteps: StepFields[];
  onChange: (next: StepFields) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  catalogAgents: CatalogAgent[];
  catalogSkills: CatalogSkill[];
  executors: ExecutorProfile[];
  pending: boolean;
}) {
  const idPrefix = `step-${index}`;
  const earlierTargets = earlierSteps(allSteps, index);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Step {index + 1}</h4>
        <div className="flex gap-1">
          <Button type="button" variant="outline" size="icon-sm" aria-label={`Move step ${index + 1} up`} disabled={pending || index === 0} onClick={onMoveUp}>
            <ChevronUp aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" size="icon-sm" aria-label={`Move step ${index + 1} down`} disabled={pending || index === allSteps.length - 1} onClick={onMoveDown}>
            <ChevronDown aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onRemove} aria-label={`Remove step ${index + 1}`}>Remove</Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-name`}>Name</Label>
          <Input
            id={`${idPrefix}-name`}
            value={step.name}
            onChange={(e) => {
              const name = e.target.value;
              onChange({ ...step, name, id: step.isNew && !step.idTouched ? slugify(name) : step.id });
            }}
            aria-label={`Step ${index + 1} name`}
            disabled={pending}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-id`}>Id</Label>
          <Input
            id={`${idPrefix}-id`}
            value={step.id}
            onChange={(e) => onChange({ ...step, id: e.target.value, idTouched: true })}
            aria-label={`Step ${index + 1} id`}
            disabled={pending || !step.isNew}
          />
        </div>
      </div>

      <AgentConfigEditor
        idPrefix={idPrefix}
        value={step}
        onChange={(next) => onChange({ ...step, ...next })}
        catalogAgents={catalogAgents}
        catalogSkills={catalogSkills}
        executors={executors}
        pending={pending}
      />

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={step.canEditCode} onCheckedChange={(checked) => onChange({ ...step, canEditCode: checked })} disabled={pending} />
        Can edit code
      </label>
      <label className="flex items-start gap-2 text-sm">
        <Switch checked={step.canRunCommands} onCheckedChange={(checked) => onChange({ ...step, canRunCommands: checked })} disabled={pending} className="mt-0.5" />
        <span>
          Can run commands
          <span className={`block text-xs text-muted-foreground${step.canEditCode ? ' opacity-60' : ''}`}>
            The step may run shell commands such as installing dependencies and running tests. It still must not change project source files, and its work is not committed.
          </span>
          {step.canEditCode && <span className="block text-xs text-muted-foreground">Included with Can edit code.</span>}
        </span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={step.requiresApproval} onCheckedChange={(checked) => onChange({ ...step, requiresApproval: checked })} disabled={pending} />
        Requires human approval
      </label>
      {step.requiresApproval && (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={step.requestChangesEnabled}
              onCheckedChange={(checked) => onChange({ ...step, requestChangesEnabled: checked === true })}
              disabled={pending || earlierTargets.length === 0}
            />
            Send Request changes back to an earlier step
          </label>
          {step.requestChangesEnabled && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${idPrefix}-request-changes-target`}>Go back to</Label>
              <Select value={step.requestChangesToStepId} onValueChange={(toStepId) => onChange({ ...step, requestChangesToStepId: toStepId })} disabled={pending}>
                <SelectTrigger id={`${idPrefix}-request-changes-target`} className="w-56"><SelectValue placeholder="Choose a step" /></SelectTrigger>
                <SelectContent>
                  {earlierTargets.map((target, targetIndex) => (
                    <SelectItem key={target.id || targetIndex} value={target.id}>{target.name || `Step ${targetIndex + 1}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-quick-look`}>Quick look</Label>
        <Select value={step.quickLook} onValueChange={(quickLook) => onChange({ ...step, quickLook: quickLook as QuickLookKind })} disabled={pending}>
          <SelectTrigger id={`${idPrefix}-quick-look`} className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            {QUICK_LOOK_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {QUICK_LOOK_OPTIONS.find((option) => option.value === step.quickLook)?.hint}. Applies to runs started after you save.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={step.loopBackEnabled}
            onCheckedChange={(checked) => onChange({ ...step, loopBackEnabled: checked === true })}
            disabled={pending || earlierTargets.length === 0}
          />
          Loop back on issues
        </label>
        {earlierTargets.length === 0 && (
          <p className="text-xs italic text-muted-foreground">No earlier step to loop back to yet.</p>
        )}
        {step.loopBackEnabled && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${idPrefix}-loopback-target`}>Loop back to</Label>
              <Select value={step.loopBackToStepId} onValueChange={(toStepId) => onChange({ ...step, loopBackToStepId: toStepId })} disabled={pending}>
                <SelectTrigger id={`${idPrefix}-loopback-target`} className="w-56"><SelectValue placeholder="Choose a step" /></SelectTrigger>
                <SelectContent>
                  {earlierTargets.map((target, targetIndex) => (
                    <SelectItem key={target.id || targetIndex} value={target.id}>{target.name || `Step ${targetIndex + 1}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${idPrefix}-loopback-rounds`}>Max rounds</Label>
              <Input
                id={`${idPrefix}-loopback-rounds`}
                type="number"
                min={1}
                max={10}
                value={step.loopBackMaxRounds}
                onChange={(e) => onChange({ ...step, loopBackMaxRounds: e.target.value })}
                disabled={pending}
                className="w-24"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The full create/edit form for one WorkflowRecord — a Dialog (rather than an inline row-swap like Agents/Skills) since a workflow's steps make this far larger than either of those forms. */
function WorkflowEditorDialog({
  workflow,
  catalogAgents,
  catalogSkills,
  executors,
  pending,
  onCancel,
  onSave,
}: {
  workflow?: WorkflowRecord;
  catalogAgents: CatalogAgent[];
  catalogSkills: CatalogSkill[];
  executors: ExecutorProfile[];
  pending: boolean;
  onCancel: () => void;
  onSave: (id: string, fields: WorkflowFormFields) => void;
}) {
  const initial = workflow ? workflowFieldsFromRecord(workflow) : emptyWorkflowFields();
  const [name, setName] = useState(initial.name);
  const { id, onNameChange, onIdChange } = useSlugFollowingId(workflow?.id);
  const [description, setDescription] = useState(initial.description);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [branchType, setBranchType] = useState(initial.branchType);
  const [steps, setSteps] = useState<StepFields[]>(initial.steps);

  const fields: WorkflowFormFields = { name, description, enabled, branchType, steps };
  const validationError = validateWorkflowForm(fields, !workflow, id);
  const canSave = validationError === null && !pending;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="flex h-[min(880px,var(--popup-max-height))] w-[min(760px,96vw)] max-w-none flex-col gap-0 overflow-hidden p-0" aria-label={workflow ? `Edit workflow "${workflow.name}"` : 'New workflow'}>
        <DialogHeader className="border-b border-border px-6 py-4 text-left">
          <DialogTitle>{workflow ? `Edit "${workflow.name}"` : 'New workflow'}</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave) return;
            onSave(workflow?.id ?? id, fields);
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-4">
            {validationError && <Alert variant="destructive" role="alert"><AlertDescription>{validationError}</AlertDescription></Alert>}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="workflow-name">Name</Label>
                <Input id="workflow-name" value={name} onChange={(e) => onNameChange(e.target.value, setName)} aria-label="Workflow name" disabled={pending} autoFocus />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="workflow-id">Id</Label>
                <Input id="workflow-id" value={workflow?.id ?? id} onChange={(e) => onIdChange(e.target.value)} aria-label="Workflow id" disabled={pending || !!workflow} />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="workflow-description">Description</Label>
              <Textarea id="workflow-description" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Workflow description" rows={2} disabled={pending} />
            </div>

            <div className="grid gap-1.5 sm:max-w-xs">
              <Label htmlFor="workflow-branch-type">Branch type</Label>
              <Input id="workflow-branch-type" value={branchType} onChange={(e) => setBranchType(e.target.value)} placeholder="feature or bugfix" aria-label="Workflow branch type" disabled={pending} />
              <span className="text-xs text-muted-foreground">
                {branchType.trim() ? `New branches are always named ${branchType.trim()}/…` : 'Leave blank for feature/… branches.'}
              </span>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Switch checked={enabled} onCheckedChange={setEnabled} disabled={pending} />
              Enabled
            </label>

            <div className="flex flex-col gap-3">
              <h4 className="text-sm font-semibold">Steps</h4>
              {steps.map((step, index) => (
                <StepEditor
                  key={index}
                  step={step}
                  index={index}
                  allSteps={steps}
                  onChange={(next) => setSteps(steps.map((s, i) => (i === index ? next : s)))}
                  onRemove={() => setSteps(removeStep(steps, index))}
                  onMoveUp={() => setSteps(moveStep(steps, index, -1))}
                  onMoveDown={() => setSteps(moveStep(steps, index, 1))}
                  catalogAgents={catalogAgents}
                  catalogSkills={catalogSkills}
                  executors={executors}
                  pending={pending}
                />
              ))}
              <Button type="button" variant="outline" onClick={() => setSteps(addStep(steps))} disabled={pending}>+ Add step</Button>
            </div>

            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              Complete — commit, push and raise a PR <span className="italic">(built-in, always runs last)</span>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={!canSave}>{pending ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WorkflowsTab() {
  const workflows = useWorldStore((s) => s.catalogWorkflows);
  const catalogAgents = useWorldStore((s) => s.catalogAgents);
  const catalogSkills = useWorldStore((s) => s.catalogSkills);
  const executors = useWorldStore((s) => s.executors);
  const createCatalogWorkflow = useWorldStore((s) => s.createCatalogWorkflow);
  const updateCatalogWorkflow = useWorldStore((s) => s.updateCatalogWorkflow);
  const deleteCatalogWorkflow = useWorldStore((s) => s.deleteCatalogWorkflow);
  const lastError = useErrorScope('catalog');

  // 'new' opens a blank editor; a WorkflowRecord opens it pre-filled for edit; null keeps it closed.
  const [editing, setEditing] = useState<'new' | WorkflowRecord | null>(null);
  const [deleting, setDeleting] = useState<WorkflowRecord | null>(null);
  // Which row (or 'new'/the row being deleted) a save/remove/toggle is currently in flight for.
  const [pendingId, setPendingId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-semibold">Workflows</h3>
        <p className="mt-1 text-xs text-muted-foreground">The ordered stages a Project's Tasks run through — an agent per stage, review loops, and human-approval gates.</p>
      </div>

      <FormErrorAlert message={lastError} />

      {workflows.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">No workflows yet. Add one below.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {workflows.map((workflow) => (
            <li key={workflow.id} className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card p-3">
              <div className="flex min-w-40 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-semibold">{workflow.name}</span>
                <span className="text-xs text-muted-foreground line-clamp-1">{workflow.description}</span>
                <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <Badge variant={workflow.enabled ? 'success' : 'secondary'}>{workflow.enabled ? 'Enabled' : 'Disabled'}</Badge>
                  {workflow.id === DEFAULT_WORKFLOW_ID && <Badge variant="outline">Seeded default</Badge>}
                  {workflow.branchType && <Badge variant="outline">{workflow.branchType}/… branches</Badge>}
                  <span className="text-xs text-muted-foreground">{workflow.steps.length} step{workflow.steps.length === 1 ? '' : 's'}</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pendingId === workflow.id}
                  onClick={async () => {
                    setPendingId(workflow.id);
                    await updateCatalogWorkflow(workflow.id, { enabled: !workflow.enabled });
                    setPendingId(null);
                  }}
                >
                  {workflow.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setEditing(workflow)} disabled={pendingId === workflow.id}>Edit</Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pendingId === workflow.id}
                  onClick={() => setDeleting(workflow)}
                  aria-label={`Remove "${workflow.name}"`}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-1 border-t border-border pt-4">
        <Button type="button" onClick={() => setEditing('new')}>+ New workflow</Button>
      </div>

      {editing !== null && (
        <WorkflowEditorDialog
          key={editing === 'new' ? 'new' : editing.id}
          workflow={editing === 'new' ? undefined : editing}
          catalogAgents={catalogAgents}
          catalogSkills={catalogSkills}
          executors={executors}
          pending={pendingId === (editing === 'new' ? 'new' : editing.id)}
          onCancel={() => setEditing(null)}
          onSave={async (id, fields) => {
            const key = editing === 'new' ? 'new' : editing.id;
            setPendingId(key);
            const ok = editing === 'new'
              ? await createCatalogWorkflow(buildCreateWorkflowInput(id, fields))
              : await updateCatalogWorkflow(editing.id, buildUpdateWorkflowPatch(fields));
            setPendingId(null);
            if (ok) setEditing(null);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete "${deleting.name}"?`}
          description="Every Project using this workflow falls back to the Catalog default. This can't be undone."
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            setPendingId(deleting.id);
            await deleteCatalogWorkflow(deleting.id);
            setPendingId(null);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}
