import { useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NAME_HINT, PROJECT_NAME_MAX, canConfirmDelete, canSaveName, deleteFailureOf, readOnlyReason } from '../../lib/projectGeneralSettings';
import type { DeleteFailure } from '../../lib/projectGeneralSettings';
import { useWorldStore } from '../../store/worldStore';
import type { ProjectData } from '../../types';

/** The General section: the project's display name and its removal. Both apply to every Building type. */
export function GeneralSettings({ project }: { project: ProjectData }) {
  const reason = readOnlyReason(project);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <h3 className="text-base font-semibold tracking-tight">General</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">Name and removal of this project.</p>
      <NameCard key={project.id} project={project} reason={reason} />
      <DangerZone project={project} reason={reason} />
    </div>
  );
}

function NameCard({ project, reason }: { project: ProjectData; reason: string | null }) {
  const renameProject = useWorldStore((s) => s.renameProject);
  const [value, setValue] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (reason || !canSaveName(value, project.name, saving)) return;
    setSaving(true);
    setError(null);
    try {
      await renameProject(project.id, value.trim());
      setValue(value.trim());
      toast.success('Project renamed');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not rename the project.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={save} className="mt-5 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <h4 className="text-sm font-semibold">Project name</h4>
      <Label htmlFor="project-name" className="mt-3 block text-sm">Project name</Label>
      <Input
        id="project-name"
        className="mt-1 max-w-md"
        value={value}
        maxLength={PROJECT_NAME_MAX}
        disabled={reason !== null}
        aria-describedby="project-name-hint"
        onChange={(event) => { setValue(event.target.value); setError(null); }}
      />
      <p id="project-name-hint" className="mt-1 text-xs text-muted-foreground">{NAME_HINT}</p>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      {reason && <p className="mt-2 text-sm text-muted-foreground">{reason}</p>}
      <Button type="submit" className="mt-3" disabled={reason !== null || !canSaveName(value, project.name, saving)}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </form>
  );
}

function DangerZone({ project, reason }: { project: ProjectData; reason: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-6 rounded-xl border border-destructive/40 bg-card p-4 text-card-foreground shadow-sm" aria-labelledby="danger-zone-title">
      <h4 id="danger-zone-title" className="text-sm font-semibold text-destructive">Danger zone</h4>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">Delete this project and everything it owns. This cannot be undone.</p>
        <Button type="button" variant="destructive" disabled={reason !== null} onClick={() => setOpen(true)}>Delete project</Button>
      </div>
      {reason && <p className="mt-2 text-sm text-muted-foreground">{reason}</p>}
      {open && <DeleteDialog project={project} onClose={() => setOpen(false)} />}
    </section>
  );
}

function DeleteDialog({ project, onClose }: { project: ProjectData; onClose: () => void }) {
  const deleteProject = useWorldStore((s) => s.deleteProject);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<DeleteFailure | null>(null);
  const locked = failure?.mode === 'locked';
  const confirm = async () => {
    setDeleting(true);
    setFailure(null);
    try {
      await deleteProject(project.id);
      toast.success('Project deleted');
    } catch (error) {
      setFailure(deleteFailureOf(error));
      setDeleting(false);
    }
  };
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !deleting) onClose(); }}>
      <DialogContent role="alertdialog" className="max-w-md" aria-describedby="delete-project-body">
        <DialogHeader>
          <DialogTitle>Delete project?</DialogTitle>
          <DialogDescription id="delete-project-body" className="break-words">
            You are about to delete <strong>{project.name}</strong>. Its folder and all its tasks, sessions and data under{' '}
            <code className="break-all font-mono">projects/{project.slug}</code> will be removed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {!locked && (
          <div className="min-w-0">
            <Label htmlFor="delete-project-confirm" className="block break-words text-sm">Type <strong>{project.name}</strong> to confirm</Label>
            <Input id="delete-project-confirm" className="mt-1" autoComplete="off" autoFocus value={typed} disabled={deleting} onChange={(event) => setTyped(event.target.value)} />
          </div>
        )}
        {failure && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{failure.message}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={deleting} onClick={onClose}>{locked ? 'Close' : 'Cancel'}</Button>
          {!locked && (
            <Button type="button" variant="destructive" disabled={deleting || !canConfirmDelete(typed, project.name)} onClick={() => void confirm()}>
              {deleting ? 'Deleting…' : 'Delete project'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
