import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { canContinueFromFile, completionText, confirmLabel, fileError, FIELD_LABELS, lostWarning, MAPPABLE_FIELDS, mappingError, problemLines, stepAfterFile } from '../lib/seoBacklinks';
import type { CommitDto, Controls, ImportMode, ImportRequestDto, PreviewDto, WizardStep } from '../lib/seoBacklinks';
import { toBase64 } from '../lib/serverApi';
import { useSeoBacklinksStore } from '../store/seoBacklinksStore';

const MANUAL = 'manual';
const cell = (v: string | number | boolean | null | undefined) => (v === null || v === undefined || v === '' ? '—' : String(v));

/** The CSV import wizard: file and format, column mapping (manual only), a preview that saves nothing, then the confirmed import. */
export function SeoBacklinkImport({ projectId, controls, onClose }: { projectId: string; controls: Controls; onClose: () => void }) {
  const { previewImport, commitImport } = useSeoBacklinksStore.getState();
  const saved = useSeoBacklinksStore((s) => s.mappingsByProject[projectId] ?? []);
  const [step, setStep] = useState<WizardStep>('file');
  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState('');
  const [format, setFormat] = useState('auto');
  const [mode, setMode] = useState<ImportMode | null>(null);
  const [preview, setPreview] = useState<PreviewDto | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CommitDto | null>(null);

  const fileProblem = file ? fileError(file) : null;
  const request = (extra: Partial<ImportRequestDto> = {}): ImportRequestDto => ({ fileName: file!.name, content, mode: mode ?? undefined, ...extra });
  const formatBody = (): Partial<ImportRequestDto> => {
    const savedMapping = saved.find((m) => `saved:${m.name}` === format);
    if (savedMapping) return { mapping: savedMapping.mapping };
    return format === MANUAL && Object.keys(mapping).length ? { mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) } : { format };
  };

  const choose = async (picked: File | null) => {
    setFile(picked); setError(null);
    setContent(picked && !fileError(picked) ? await toBase64(picked) : '');
  };
  const runPreview = async (body: Partial<ImportRequestDto>, from: WizardStep) => {
    setBusy(true); setError(null);
    const res = await previewImport(projectId, request(body));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setPreview(res.preview);
    if (from === 'file') { setMapping(res.preview.mapping ?? {}); setStep(stepAfterFile(res.preview)); } else setStep('preview');
  };
  const commit = async () => {
    setBusy(true); setError(null);
    const res = await commitImport(projectId, request({ mapping: preview?.mapping, confirm: true, rememberAs: remember.trim() || undefined }), controls);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setResult(res.result); setStep('done');
  };

  const problems = preview?.problemsTotal ?? 0;
  const confirm = confirmLabel(preview?.valid ?? 0, problems);
  const warning = lostWarning(mode, preview?.willBeLost ?? 0);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto" aria-label="Import backlinks">
        <DialogHeader>
          <DialogTitle>Import backlinks from CSV</DialogTitle>
          <DialogDescription>Nothing is saved until you confirm the preview.</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

        {step === 'file' && (
          <div className="grid gap-3 text-sm">
            <label className="grid gap-1">File (.csv, .tsv or .txt)
              <Input type="file" accept=".csv,.tsv,.txt" aria-label="Backlinks file" onChange={(e) => void choose(e.target.files?.[0] ?? null)} />
            </label>
            {fileProblem && <p className="m-0 text-destructive">{fileProblem}</p>}
            <label className="grid gap-1">Format
              <select aria-label="Format" className="h-9 rounded border bg-background px-2" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="auto">Detect from the file</option>
                <option value="ahrefs">Ahrefs</option><option value="semrush">Semrush</option><option value="moz">Moz</option><option value="gsc">Google Search Console</option>
                {saved.map((m) => <option key={m.name} value={`saved:${m.name}`}>Saved: {m.name}</option>)}
                <option value={MANUAL}>Manual mapping</option>
              </select>
            </label>
            <fieldset className="grid gap-1 border-0 p-0" aria-label="Full or partial">
              <legend className="mb-1">What does this file hold?</legend>
              <label className="flex items-start gap-2"><input type="radio" name="mode" checked={mode === 'full'} onChange={() => setMode('full')} /><span><b>Full export.</b> Links missing from this file are marked lost.</span></label>
              <label className="flex items-start gap-2"><input type="radio" name="mode" checked={mode === 'partial'} onChange={() => setMode('partial')} /><span><b>Partial update.</b> Links missing from this file are left as they are.</span></label>
            </fieldset>
          </div>
        )}

        {step === 'mapping' && preview && (
          <div className="grid gap-2 text-sm">
            <p className="m-0 text-muted-foreground">Choose which column holds each field. Columns you leave out are kept as extras.</p>
            {MAPPABLE_FIELDS.map((field) => (
              <label key={field} className="grid grid-cols-[12rem_1fr] items-center gap-2">{FIELD_LABELS[field]}
                <select aria-label={FIELD_LABELS[field]} className="h-8 rounded border bg-background px-2" value={mapping[field] ?? ''} onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}>
                  <option value="">Not in the file</option>
                  {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
            {mappingError(mapping) && <p className="m-0 text-destructive">{mappingError(mapping)}</p>}
            <label className="grid gap-1">Remember this mapping as (optional)
              <Input aria-label="Mapping name" maxLength={60} value={remember} onChange={(e) => setRemember(e.target.value)} />
            </label>
          </div>
        )}

        {step === 'preview' && preview && (
          <div className="grid gap-3 text-sm">
            <p className="m-0"><b>{preview.valid}</b> valid rows, <b>{preview.invalid}</b> with errors, <b>{preview.duplicates}</b> duplicates, out of {preview.rows} rows.</p>
            {warning && <Alert><AlertDescription>{warning}</AlertDescription></Alert>}
            <div className="overflow-x-auto">
              <table className="w-full text-xs" aria-label="Preview of mapped rows">
                <thead><tr className="text-left text-muted-foreground"><th>Source</th><th>Target</th><th>Anchor</th><th className="text-right">DR</th><th className="text-right">UR</th><th className="text-right">Traffic</th></tr></thead>
                <tbody>{(preview.sample ?? []).map((r, i) => (
                  <tr key={i}><td className="break-all pr-2">{cell(r.sourceUrl)}</td><td className="break-all pr-2">{cell(r.targetUrl)}</td><td className="pr-2">{cell(r.anchor)}</td><td className="text-right">{cell(r.sourceDr)}</td><td className="text-right">{cell(r.sourceUr)}</td><td className="text-right">{cell(r.sourceTraffic)}</td></tr>
                ))}</tbody>
              </table>
            </div>
            {problems > 0 && (
              <div>
                <h5 className="m-0 text-xs font-semibold uppercase text-muted-foreground">Problems</h5>
                <ul className="m-0 max-h-40 list-none overflow-y-auto p-0 text-xs" aria-label="Problems">{problemLines(preview.problems ?? [], problems).map((l) => <li key={l}>{l}</li>)}</ul>
                <p className="m-0 mt-1 text-xs text-muted-foreground">Rows with problems are skipped. Nothing is saved until you confirm.</p>
              </div>
            )}
          </div>
        )}

        {step === 'done' && result && <p className="m-0 text-sm" role="status">{completionText(result)}</p>}

        <DialogFooter>
          {step === 'done' ? <Button onClick={onClose}>Close</Button> : (
            <>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              {step === 'file' && <Button disabled={busy || !canContinueFromFile(file !== null, fileProblem, mode)} onClick={() => void runPreview(format === MANUAL ? { format: MANUAL } : formatBody(), 'file')}>Next</Button>}
              {step === 'mapping' && <Button disabled={busy || mappingError(mapping) !== null} onClick={() => void runPreview({ mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) }, 'mapping')}>Preview</Button>}
              {step === 'preview' && <Button disabled={busy || confirm.disabled} onClick={() => void commit()}>{confirm.text}</Button>}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
