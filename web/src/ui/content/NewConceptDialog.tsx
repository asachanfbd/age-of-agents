import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FORMATS_BY_PLATFORM, PLATFORMS, PLATFORM_LABELS } from '../../lib/contentRules';
import type { Platform } from '../../lib/contentRules';
import { applyDateToAll, BRIEF_MAX, checkNewConcept, clearChoices, loadChoices, newConceptForm, saveChoices, TITLE_MAX, toggleFormat, togglePlatform, willCreateLabel } from '../../lib/contentDefaults';
import type { NewConceptForm } from '../../lib/contentDefaults';
import { formatLabel } from '../../lib/contentView';
import { useContentStore } from '../../store/contentStore';
import { ErrorNote } from '../crm/shared';
import { PlatformIcon } from './shared';

/** Platform and format checkboxes (each platform's last choices come back ticked), one date per platform and an Apply to all button. */
export function NewConceptDialog({ projectId, timeZone, onCreated, onCancel }: { projectId: string; timeZone: string; onCreated: (conceptId: string) => void; onCancel: () => void }) {
  const [form, setForm] = useState<NewConceptForm>(() => newConceptForm(loadChoices()));
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const createConcept = useContentStore((s) => s.createConcept);
  const setChoices = (choices: NewConceptForm['choices']) => setForm((f) => ({ ...f, choices }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const check = checkNewConcept(form, timeZone);
    setErrors(check.errors);
    if (check.errors.length) return;
    setPending(true);
    const result = await createConcept(projectId, { title: check.title, brief: form.brief, posts: check.posts });
    setPending(false);
    if (!result.ok) { setErrors([result.error]); return; }
    saveChoices(form.choices);
    onCreated(result.concept.id);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent className="sm:max-w-[720px]">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New concept</DialogTitle>
            <DialogDescription>One content idea and, if you like, its first posts. Dates are in {timeZone}.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="concept-title">Title <span className="text-muted-foreground">(up to {TITLE_MAX} characters)</span></Label>
            <Input id="concept-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />
            <Label htmlFor="concept-brief">Brief <span className="text-muted-foreground">(up to {BRIEF_MAX} characters)</span></Label>
            <Textarea id="concept-brief" value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} rows={3} />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1"><Label htmlFor="concept-all-at">Date and time</Label><Input id="concept-all-at" type="datetime-local" value={form.allAt} onChange={(e) => setForm({ ...form, allAt: e.target.value })} /></div>
            <Button type="button" variant="outline" onClick={() => setForm(applyDateToAll(form))}>Apply to all platforms</Button>
            <Button type="button" variant="ghost" onClick={() => setChoices(clearChoices())}>Clear selection</Button>
          </div>
          <div className="grid gap-2" role="group" aria-label="Platforms and formats">
            {PLATFORMS.map((platform: Platform) => {
              const choice = form.choices[platform];
              return (
                <div key={platform} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border p-2.5">
                  <label className="flex w-36 items-center gap-2 text-sm font-medium"><input type="checkbox" checked={choice.on} onChange={() => setChoices(togglePlatform(form.choices, platform))} /><PlatformIcon platform={platform} />{PLATFORM_LABELS[platform]}</label>
                  {FORMATS_BY_PLATFORM[platform].map((format) => (
                    <label key={format} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={choice.formats.includes(format)} onChange={() => setChoices(toggleFormat(form.choices, platform, format))} />{formatLabel(format)}</label>
                  ))}
                  {choice.on && <Input className="ml-auto w-52" type="datetime-local" aria-label={`${PLATFORM_LABELS[platform]} date and time`} value={form.at[platform]} onChange={(e) => setForm({ ...form, at: { ...form.at, [platform]: e.target.value } })} />}
                </div>
              );
            })}
          </div>
          <p className="m-0 text-sm text-muted-foreground">{willCreateLabel(form.choices)}</p>
          {errors.map((e) => <ErrorNote key={e} message={e} />)}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
