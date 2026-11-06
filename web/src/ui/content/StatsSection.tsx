import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { applyExtraction, checkStatForm, checkUpload, clearMark, emptyStatForm, failureText, formFromStat, shouldDiscard, statBody, unusedText } from '../../lib/contentStats';
import type { StatForm } from '../../lib/contentStats';
import { contentApi } from '../../lib/contentApi';
import type { ConceptDto, PostDto, StatDto } from '../../lib/contentTypes';
import { READ_ONLY_TITLE } from '../../lib/contentView';
import { localTextToInstant } from '../../lib/contentZone';
import { useContentStore } from '../../store/contentStore';
import { StatsForm, StatsList } from './StatsView';

interface FormProps { projectId: string; concept: ConceptDto; post: PostDto; timeZone: string; readOnly: boolean; stat: StatDto | null; onClose: () => void }

/** The Add stats and Edit stats form with its extraction state; an extraction that was never saved is discarded when the form closes. */
function StatsFormPanel({ projectId, concept, post, timeZone, readOnly, stat, onClose }: FormProps) {
  const { extractStats, discardExtraction, createStat, patchStat } = useContentStore.getState();
  const [form, setForm] = useState<StatForm>(() => (stat ? formFromStat(stat) : emptyStatForm(new Date().toISOString())));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [unused, setUnused] = useState<string | null>(null);
  const [extractionId, setExtractionId] = useState<string | null>(null);
  const saved = useRef(false);
  const open = useRef<string | null>(null);
  useEffect(() => { open.current = extractionId; }, [extractionId]);
  useEffect(() => () => { if (open.current && shouldDiscard(open.current, saved.current)) void discardExtraction(projectId, concept.id, post.id, open.current); }, [projectId, concept.id, post.id, discardExtraction]);

  const edit = (change: (f: StatForm) => StatForm, key: string) => setForm((f) => clearMark(change(f), key));
  const extract = async () => {
    const problem = checkUpload(text, files);
    setUploadError(problem);
    if (problem) return;
    setExtracting(true); setFailure(null); setUnused(null);
    const result = await extractStats(projectId, concept.id, post.id, text, files);
    setExtracting(false);
    if (!result.ok) { setFailure(failureText(result.error)); return; }
    if (!result.reply.ok) { setFailure(failureText(result.reply.reason)); return; }
    if (extractionId) void discardExtraction(projectId, concept.id, post.id, extractionId);
    const filled = applyExtraction(form, result.reply);
    setForm(filled.form); setUnused(unusedText(filled.unused)); setExtractionId(result.reply.extractionId);
  };
  const save = async () => {
    const check = checkStatForm(form, { format: post.format, publishedAt: post.publishedAt ?? new Date(0).toISOString(), now: Date.now() });
    setErrors(check.errors);
    if (!check.ok) return;
    setPending(true);
    const body = statBody(form, post.platform, extractionId ?? undefined);
    const result = stat ? await patchStat(projectId, concept.id, post.id, stat.id, body) : await createStat(projectId, concept.id, post.id, body);
    setPending(false);
    if (!result.ok) { setSaveError(result.error); return; }
    saved.current = true;
    onClose();
  };
  return (
    <StatsForm
      platform={post.platform} format={post.format} timeZone={timeZone} form={form} errors={errors} saveError={saveError} pending={pending} readOnly={readOnly} editing={stat !== null}
      extractText={text} files={files} extracting={extracting} uploadError={uploadError} failure={failure} unused={unused}
      onField={(key, value) => edit((f) => ({ ...f, counts: { ...f.counts, [key]: value } }), key)}
      onCaptured={(local) => edit((f) => ({ ...f, capturedAt: localTextToInstant(local, timeZone) }), 'capturedAt')}
      onWatch={(value) => setForm((f) => ({ ...f, watchTime: value }))} onNote={(value) => setForm((f) => ({ ...f, note: value }))}
      onText={setText} onFiles={(added) => setFiles((current) => [...current, ...added])} onRemoveFile={(i) => setFiles((current) => current.filter((_, j) => j !== i))}
      onExtract={() => void extract()} onSave={() => void save()} onCancel={onClose}
    />
  );
}

/** The expandable Stats section of a published post: snapshots, Add stats and edit. */
export function StatsSection({ projectId, concept, post, timeZone, readOnly }: { projectId: string; concept: ConceptDto; post: PostDto; timeZone: string; readOnly: boolean }) {
  const snapshots = useContentStore((s) => s.statsByPost[post.id]) ?? [];
  const { loadStats, deleteStat } = useContentStore.getState();
  const [form, setForm] = useState<{ stat: StatDto | null } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void loadStats(projectId, concept.id, post.id).then((r) => setError(r.ok ? null : r.error)); }, [projectId, concept.id, post.id, loadStats]);
  const remove = async (id: string) => { const r = await deleteStat(projectId, concept.id, post.id, id); setConfirming(null); setError(r.ok ? null : r.error); };
  return (
    <div className="grid gap-2" aria-label="Stats">
      <div className="flex items-center justify-between gap-2">
        <h4 className="m-0 text-sm font-medium">Stats</h4>
        {!form && <Button size="sm" disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined} onClick={() => setForm({ stat: null })}>Add stats</Button>}
      </div>
      {form && <StatsFormPanel key={form.stat?.id ?? 'new'} projectId={projectId} concept={concept} post={post} timeZone={timeZone} readOnly={readOnly} stat={form.stat} onClose={() => setForm(null)} />}
      <StatsList
        platform={post.platform} format={post.format} snapshots={snapshots} timeZone={timeZone} readOnly={readOnly} confirmingId={confirming} error={error}
        sourceUrl={(statId, sourceId) => contentApi.sourceUrl(projectId, concept.id, post.id, statId, sourceId)}
        onEdit={(stat) => setForm({ stat })} onAskDelete={setConfirming} onConfirmDelete={(id) => void remove(id)} onCancelDelete={() => setConfirming(null)}
      />
    </div>
  );
}
