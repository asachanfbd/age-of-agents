import { useCallback, useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { contentApi } from '../../lib/contentApi';
import { controlsDisabled, NEW_COLOUR_HEX, READ_ONLY_TITLE } from '../../lib/contentView';
import type { BrandFileDto, ColourDto, SectionMetaDto } from '../../lib/contentTypes';
import { errorText, useLoad } from '../crm/crmHooks';
import { ErrorNote } from '../crm/shared';
import { RelativeTime } from '../design/RelativeTime';
import { VersionedEditor } from './VersionedEditor';

export const SECTION_MAX = 50_000;
export const FILES_LIMIT_TEXT = 'Up to 100 files, 50 MB each';
export const COLOURS_MAX = 20;

function Sections({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const list = useLoad(() => contentApi.sections(projectId), [projectId]);
  const [picked, setPicked] = useState('about');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sections: SectionMetaDto[] = list.data?.sections ?? [];
  const current = sections.find((s) => s.id === picked) ?? sections[0];
  const disabled = controlsDisabled(readOnly);
  const load = useCallback(() => contentApi.section(projectId, current?.id ?? 'about'), [projectId, current?.id]);
  const save = useCallback((content: string, version: string) => contentApi.saveSection(projectId, current?.id ?? 'about', { content, version }), [projectId, current?.id]);
  const act = async (work: () => Promise<unknown>) => { try { await work(); setError(null); list.reload(); } catch (e) { setError(errorText(e)); } };
  return (
    <section className="grid gap-3 md:grid-cols-[14rem_1fr]" aria-label="Business knowledge">
      <nav aria-label="Knowledge sections" className="grid content-start gap-1">
        {sections.map((s) => (
          <button key={s.id} type="button" aria-current={s.id === current?.id} onClick={() => setPicked(s.id)}
            className={`rounded-lg border-0 px-3 py-1.5 text-left text-sm ${s.id === current?.id ? 'bg-secondary font-medium' : 'bg-transparent hover:bg-secondary/60'}`}>{s.name}</button>
        ))}
        <div className="mt-2 flex gap-1.5">
          <Input aria-label="New section name" value={name} placeholder="New section" disabled={disabled} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" variant="outline" disabled={disabled || !name.trim()} onClick={() => act(async () => { const s = await contentApi.createSection(projectId, name.trim()); setName(''); setPicked(s.id); })}>Add</Button>
        </div>
        <ErrorNote message={error ?? list.error} />
      </nav>
      {current && (
        <div className="grid min-w-0 content-start gap-2" key={current.id}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-base font-semibold">{current.name}</h3>
            {!current.builtin && <Button size="sm" variant="ghost" aria-label="Delete section" disabled={disabled} onClick={() => act(async () => { await contentApi.deleteSection(projectId, current.id); setPicked('about'); })}><Trash2 />Delete</Button>}
          </div>
          <VersionedEditor label={`${current.name} (Markdown)`} max={SECTION_MAX} readOnly={readOnly} load={load} save={save} onSaved={list.reload} />
        </div>
      )}
    </section>
  );
}

function BrandFiles({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const files = useLoad(() => contentApi.files(projectId), [projectId]);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const disabled = controlsDisabled(readOnly);
  const upload = async (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) {
      try { await contentApi.uploadFile(projectId, file); setError(null); } catch (e) { setError(errorText(e)); }
    }
    if (input.current) input.current.value = '';
    files.reload();
  };
  const remove = async (f: BrandFileDto) => { try { await contentApi.deleteFile(projectId, f.name); setError(null); } catch (e) { setError(errorText(e)); } files.reload(); };
  return (
    <section className="grid gap-2" aria-label="Brand files">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-base font-semibold">Brand files <span className="text-sm font-normal text-muted-foreground">({FILES_LIMIT_TEXT})</span></h3>
        <Button variant="outline" disabled={disabled} title={disabled ? READ_ONLY_TITLE : undefined} onClick={() => input.current?.click()}><Upload />Upload</Button>
        <input ref={input} type="file" multiple hidden aria-label="Upload brand files" onChange={(e) => void upload(e.target.files)} />
      </div>
      <ErrorNote message={error ?? files.error} />
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {(files.data?.files ?? []).map((f) => (
          <li key={f.name} className="flex items-center gap-3 rounded-lg border border-border p-2 text-sm">
            {f.image && <img src={contentApi.fileUrl(projectId, f.name)} alt={f.name} className="size-10 rounded object-cover" />}
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="text-xs text-muted-foreground">{(f.size / 1024).toFixed(1)} KB · <RelativeTime at={f.changedAt} /></span>
            <a href={contentApi.fileUrl(projectId, f.name)} download={f.name} aria-label={`Download ${f.name}`}><Download className="size-4" /></a>
            <Button size="sm" variant="ghost" aria-label={`Delete ${f.name}`} disabled={disabled} onClick={() => void remove(f)}><Trash2 /></Button>
          </li>
        ))}
        {files.data && !files.data.files.length && <li className="text-sm text-muted-foreground">No files yet.</li>}
      </ul>
    </section>
  );
}

function Colours({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const loaded = useLoad(() => contentApi.colours(projectId), [projectId]);
  const [draft, setDraft] = useState<ColourDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const colours = draft ?? loaded.data?.colours ?? [];
  const disabled = controlsDisabled(readOnly);
  const update = (next: ColourDto[]) => setDraft(next);
  const save = async () => { try { const r = await contentApi.saveColours(projectId, colours); setDraft(r.colours); setError(null); } catch (e) { setError(errorText(e)); } };
  return (
    <section className="grid gap-2" aria-label="Brand colours">
      <h3 className="m-0 text-base font-semibold">Brand colours <span className="text-sm font-normal text-muted-foreground">(up to {COLOURS_MAX})</span></h3>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {colours.map((c, i) => (
          <li key={i} className="flex items-center gap-2">
            <input type="color" aria-label={`${c.name} colour`} value={c.hex} disabled={disabled} onChange={(e) => update(colours.map((x, j) => (j === i ? { ...x, hex: e.target.value.toUpperCase() } : x)))} />
            <Input className="w-48" aria-label="Colour name" value={c.name} disabled={disabled} onChange={(e) => update(colours.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <code className="text-xs">{c.hex}</code>
            <Button size="sm" variant="ghost" aria-label={`Remove ${c.name}`} disabled={disabled} onClick={() => update(colours.filter((_, j) => j !== i))}><Trash2 /></Button>
          </li>
        ))}
      </ul>
      <ErrorNote message={error ?? loaded.error} />
      <div className="flex gap-2">
        <Button variant="outline" disabled={disabled || colours.length >= COLOURS_MAX} onClick={() => update([...colours, { name: `Colour ${colours.length + 1}`, hex: NEW_COLOUR_HEX }])}>Add colour</Button>
        <Button disabled={disabled || draft === null} onClick={() => void save()}>Save colours</Button>
      </div>
    </section>
  );
}

export function KnowledgeTab({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  return (
    <div className="grid gap-8">
      <Sections projectId={projectId} readOnly={readOnly} />
      <BrandFiles projectId={projectId} readOnly={readOnly} />
      <Colours projectId={projectId} readOnly={readOnly} />
    </div>
  );
}
