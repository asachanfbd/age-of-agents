import { NativeSelect } from '@/components/ui/native-select';
import { Section } from '../design/Header';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { crmApi } from '../../lib/crmApi';
import {
  CHANNEL_OPTIONS, SEPARATOR_OPTIONS, applySuggestion, changedColumns, channelBlocker, columnRoles, commitBlocker, countLines, countRows, guessMapping, pasteBlocker, precheckFile,
  readHeaders, resultMessage, shapeText, suggestionNote, validateHandForm, withChannel, withCustom, withField, withOtherLabel,
} from '../../lib/crmImport';
import type { PasteState } from '../../lib/crmImport';
import { crmControlsDisabled, disabledTitle } from '../../lib/crmWorkspace';
import type { ChannelType, ImportResultDto, MappingDto, SeparatorName } from '../../lib/crmTypes';
import { toBase64 } from '../../lib/serverApi';
import { ErrorNote } from './shared';
import { errorText, useLoad } from './crmHooks';
import type { CrmTabProps } from './types';

type Mode = 'csv' | 'paste' | 'hand';
const MODES: Array<{ key: Mode; label: string }> = [{ key: 'csv', label: 'CSV file' }, { key: 'paste', label: 'Paste a list' }, { key: 'hand', label: 'Add one by hand' }];

function Result({ result }: { result: ImportResultDto }) {
  return (
    <div className="grid gap-2 text-sm" role="status" aria-label="Import result">
      <ul className="m-0 grid list-none gap-0.5 p-0">{countLines(result, result.committed).map((l) => <li key={l}>{l}</li>)}</ul>
      {result.reopenOffers.length > 0 && <p className="m-0 text-warning-foreground">{result.reopenOffers.length} row(s) matched a lost contact. Open the Lost tab to reopen them.</p>}
      {result.rejectedRows.length > 0 && (
        <table className="w-full text-left text-xs"><thead><tr><th>Line</th><th>Reason</th></tr></thead>
          <tbody>{result.rejectedRows.map((r) => <tr key={`${r.line}-${r.reason}`}><td>{r.line}</td><td>{r.reason}</td></tr>)}</tbody></table>
      )}
      {result.rejectedTruncated && <p className="m-0 text-xs text-muted-foreground">Only the first rejected rows are listed.</p>}
    </div>
  );
}

function ColumnSelect({ label, value, columns, disabled, onChange }: { label: string; value: string; columns: string[]; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <label className="grid gap-1 text-sm">{label}
      <NativeSelect aria-label={label} wrapperClassName="w-full" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">— not mapped —</option>{columns.map((c) => <option key={c} value={c}>{c}</option>)}
      </NativeSelect>
    </label>
  );
}

/** The column pickers for every channel and field; Other (with its label) is offered where a list may need it. */
function MappingGrid({ columns, mapping, customFields, disabled, withOther = false, onChange }: { columns: string[]; mapping: MappingDto; customFields: Array<{ id: string; name: string }>; disabled: boolean; withOther?: boolean; onChange: (m: MappingDto) => void }) {
  const channelColumn = (type: ChannelType) => mapping.channels.find((c) => c.type === type)?.column ?? '';
  const other = mapping.channels.find((c) => c.type === 'other');
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {CHANNEL_OPTIONS.filter((o) => withOther || o.value !== 'other').map((o) => <ColumnSelect key={o.value} label={`${o.label} column`} value={channelColumn(o.value)} columns={columns} disabled={disabled} onChange={(v) => onChange(withChannel(mapping, o.value, v))} />)}
      {other && <label className="grid gap-1 text-sm">Other channel label<Input aria-label="Other channel label" value={other.label ?? ''} disabled={disabled} onChange={(e) => onChange(withOtherLabel(mapping, e.target.value))} /></label>}
      <ColumnSelect label="Name column" value={mapping.name ?? ''} columns={columns} disabled={disabled} onChange={(v) => onChange(withField(mapping, 'name', v))} />
      <ColumnSelect label="Company column" value={mapping.company ?? ''} columns={columns} disabled={disabled} onChange={(v) => onChange(withField(mapping, 'company', v))} />
      <ColumnSelect label="Title column" value={mapping.title ?? ''} columns={columns} disabled={disabled} onChange={(v) => onChange(withField(mapping, 'title', v))} />
      <ColumnSelect label="Tags column" value={mapping.tags ?? ''} columns={columns} disabled={disabled} onChange={(v) => onChange(withField(mapping, 'tags', v))} />
      {customFields.map((f) => <ColumnSelect key={f.id} label={`${f.name} column`} value={mapping.custom?.[f.id] ?? ''} columns={columns} disabled={disabled} onChange={(v) => onChange(withCustom(mapping, f.id, v))} />)}
    </div>
  );
}

/** One detected column: its name, a few values and what it is mapped to. */
function ColumnCard({ name, samples, roles, byAgent }: { name: string; samples: string[]; roles: string[]; byAgent: boolean }) {
  return (
    <div className="grid content-start gap-1 rounded-control border p-2 text-xs" aria-label={`Column ${name}`}>
      <span className="text-sm font-medium">{name}</span>
      <ul className="m-0 grid list-none gap-0.5 p-0 text-muted-foreground">{samples.map((v, i) => <li key={i} className="truncate">{v}</li>)}</ul>
      <div className="flex flex-wrap gap-1">{roles.map((r) => <Badge key={r} variant={r === 'Not mapped' ? 'secondary' : 'info'}>{r}{byAgent && r !== 'Not mapped' ? ' · agent' : ''}</Badge>)}</div>
    </div>
  );
}

/** Three ways in: a CSV file (preview saves nothing, commit re-sends it), a pasted list, and one contact by hand. */
export function ImportTab({ project, readOnly, onChanged }: CrmTabProps) {
  const disabled = crmControlsDisabled(readOnly);
  const [mode, setMode] = useState<Mode>('csv');
  const settings = useLoad(() => crmApi.settings(project.id), [project.id]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResultDto | null>(null);
  // CSV
  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<MappingDto>({ channels: [] });
  const [batchName, setBatchName] = useState('');
  const [tags, setTags] = useState('');
  const [previewed, setPreviewed] = useState(false);
  // paste
  const [pasteText, setPasteText] = useState('');
  const [paste, setPaste] = useState<PasteState | null>(null);
  const [detecting, setDetecting] = useState(false);
  // hand
  const [hand, setHand] = useState({ name: '', company: '', channel: 'email' as ChannelType, handle: '' });

  const run = async (work: () => Promise<void>) => { setBusy(true); setError(null); try { await work(); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const pick = async (picked: File | null) => {
    setFile(picked); setResult(null); setPreviewed(false); setError(null); setHeaders([]); setContent('');
    if (!picked) return;
    const text = await picked.text();
    const problem = precheckFile(picked.size, countRows(text));
    if (problem) { setError(problem); return; }
    const found = readHeaders(text);
    setHeaders(found); setMapping(guessMapping(found)); setContent(await toBase64(picked));
  };
  const tagList = () => tags.split(',').map((t) => t.trim()).filter(Boolean);
  const body = () => ({ fileName: file!.name, contentBase64: content, mapping, batchName: batchName || undefined, tags: tagList() });
  const customFields = settings.data?.customFields ?? [];

  const preview = () => run(async () => { const problem = channelBlocker(mapping); if (problem) throw new Error(problem); setResult(await crmApi.previewCsv(project.id, body())); setPreviewed(true); });
  const commit = () => run(async () => { const problem = commitBlocker({ content, mapping, previewed, preview: result }); if (problem) throw new Error(problem); setResult(await crmApi.commitCsv(project.id, body())); setPreviewed(false); });
  // Detection runs only from the Detect button (or a separator or header change), never while typing, so agent calls stay rare.
  const detect = (shape: { separator?: SeparatorName; hasHeader?: boolean } = {}) => run(async () => {
    if (!pasteText.trim()) throw new Error('Paste at least one line.');
    const text = pasteText;
    setResult(null); setDetecting(true);
    try { setPaste(applySuggestion(text, await crmApi.suggestPaste(project.id, { text, ...shape }))); } finally { setDetecting(false); }
  });
  const editPasteMapping = (next: MappingDto) => setPaste((p) => p && ({ ...p, mapping: next, previewed: false, agentColumns: p.agentColumns.filter((c) => !changedColumns(p.mapping, next, [c]).length) }));
  const pasteProblem = () => pasteBlocker({ text: pasteText, detectedText: paste?.detected.text ?? null, mapping: paste?.mapping ?? { channels: [] } });
  const pasteBody = (p: PasteState, commitIt: boolean) => ({ text: p.detected.text, mapping: p.mapping, separator: p.detected.separator, hasHeader: p.detected.hasHeader, batchName: batchName || undefined, tags: tagList(), commit: commitIt });
  const previewPaste = () => run(async () => {
    const problem = pasteProblem();
    if (problem || !paste) throw new Error(problem ?? 'Detect columns before you preview.');
    const r = await crmApi.importPaste(project.id, pasteBody(paste, false));
    setResult(r); setPaste({ ...paste, previewed: true, preview: r });
  });
  const commitPaste = () => run(async () => {
    const problem = pasteProblem() ?? (paste && commitBlocker({ content: pasteText, mapping: paste.mapping, previewed: paste.previewed, preview: paste.preview }, 'list'));
    if (problem || !paste) throw new Error(problem ?? 'Detect columns before you preview.');
    setResult(await crmApi.importPaste(project.id, pasteBody(paste, true))); setPaste({ ...paste, previewed: false, preview: null });
  });
  const doHand = () => run(async () => {
    const problem = validateHandForm(hand);
    if (problem) throw new Error(problem);
    await crmApi.createContact(project.id, { name: hand.name, company: hand.company, channels: [{ type: hand.channel, handle: hand.handle }] });
    setResult({ added: 1, existing: 0, duplicatesInFile: 0, rejected: 0, rejectedRows: [], rejectedTruncated: false, reopenOffers: [], batchId: null, committed: true });
    setHand({ ...hand, handle: '', name: '' });
  });

  return (
    <div className="grid gap-4" aria-label="Import">
      <div className="flex gap-2" role="tablist" aria-label="Import mode">
        {MODES.map((m) => <Button key={m.key} role="tab" aria-selected={mode === m.key} size="sm" variant={mode === m.key ? 'default' : 'outline'} onClick={() => { setMode(m.key); setResult(null); setError(null); }}>{m.label}</Button>)}
      </div>
      <ErrorNote message={error} />
      {mode === 'csv' && (
        <Section title="CSV file">
          <div className="grid gap-3 text-sm">
            <p className="m-0 text-muted-foreground">Up to 15 MB and 50,000 rows per file. A preview saves nothing; Import re-sends the file.</p>
            <Input aria-label="CSV file" type="file" accept=".csv,text/csv" disabled={disabled} onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
            {headers.length > 0 && (
              <>
                <MappingGrid columns={headers} mapping={mapping} customFields={customFields} disabled={disabled} onChange={(m) => { setPreviewed(false); setMapping(m); }} />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input aria-label="Batch name" placeholder="Batch name (default: file name and date)" value={batchName} disabled={disabled} onChange={(e) => setBatchName(e.target.value)} />
                  <Input aria-label="Batch tags" placeholder="Tags for every new contact (comma separated)" value={tags} disabled={disabled} onChange={(e) => setTags(e.target.value)} />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void preview()}>Preview (saves nothing)</Button>
                  <Button size="sm" disabled={disabled || busy} title={disabledTitle(readOnly)} onClick={() => void commit()}>Import</Button>
                </div>
              </>
            )}
            {file && headers.length === 0 && !error && <p className="m-0 text-muted-foreground">Reading {file.name}…</p>}
          </div>
        </Section>
      )}
      {mode === 'paste' && (
        <Section title="Paste a list">
          <div className="grid gap-3 text-sm">
            <p className="m-0 text-muted-foreground">One contact per line, up to 50,000 lines. Columns split by tabs, commas, semicolons or pipes are detected; one column is fine too. A preview saves nothing.</p>
            <Textarea aria-label="Pasted list" className="min-h-40" placeholder={'Tarun Gera, +919910166500\nAnn Lee, ann@example.com'} value={pasteText} disabled={disabled} onChange={(e) => setPasteText(e.target.value)} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void detect()}>Detect columns</Button>
              {detecting && <span className="text-muted-foreground">Detecting columns… when the rules are unsure the agent is asked, which can take up to a minute.</span>}
            </div>
            {paste && (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2">Separator
                    <NativeSelect aria-label="Separator" value={paste.detected.separator} disabled={disabled || busy} onChange={(e) => void detect({ separator: e.target.value as SeparatorName, hasHeader: paste.detected.hasHeader })}>
                      {SEPARATOR_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </NativeSelect>
                  </label>
                  <label className="flex items-center gap-2">
                    <Checkbox aria-label="First line is a header" checked={paste.detected.hasHeader} disabled={disabled || busy} onCheckedChange={(v) => void detect({ separator: paste.detected.separator, hasHeader: v === true })} />First line is a header
                  </label>
                  <span className="text-muted-foreground">{shapeText(paste.detected.columns.length, paste.detected.rows)}</span>
                </div>
                <p className="m-0 text-muted-foreground" role="status">{suggestionNote(paste.detected)}</p>
                {paste.detected.text !== pasteText && <p className="m-0 text-warning-foreground">The text changed since the columns were detected. Detect columns again before you preview.</p>}
                <div className="grid gap-2 sm:grid-cols-3">
                  {paste.detected.columns.map((c) => <ColumnCard key={c.name} name={c.name} samples={c.samples} roles={columnRoles(paste.mapping, c.name, customFields)} byAgent={paste.agentColumns.includes(c.name)} />)}
                </div>
                <MappingGrid columns={paste.detected.columns.map((c) => c.name)} mapping={paste.mapping} customFields={customFields} disabled={disabled} withOther onChange={editPasteMapping} />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input aria-label="Batch name" placeholder="Batch name (default: Pasted list and date)" value={batchName} disabled={disabled} onChange={(e) => setBatchName(e.target.value)} />
                  <Input aria-label="Batch tags" placeholder="Tags for every new contact (comma separated)" value={tags} disabled={disabled} onChange={(e) => setTags(e.target.value)} />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void previewPaste()}>Preview (saves nothing)</Button>
                  <Button size="sm" disabled={disabled || busy} title={disabledTitle(readOnly)} onClick={() => void commitPaste()}>Import</Button>
                </div>
              </>
            )}
          </div>
        </Section>
      )}
      {mode === 'hand' && (
        <Section title="Add one by hand">
          <div className="grid max-w-md gap-2 text-sm">
            <Input aria-label="Name" placeholder="Name (optional)" value={hand.name} disabled={disabled} onChange={(e) => setHand({ ...hand, name: e.target.value })} />
            <Input aria-label="Company" placeholder="Company (optional)" value={hand.company} disabled={disabled} onChange={(e) => setHand({ ...hand, company: e.target.value })} />
            <div className="flex gap-2">
              <NativeSelect aria-label="Channel type"  value={hand.channel} disabled={disabled} onChange={(e) => setHand({ ...hand, channel: e.target.value as ChannelType })}>{CHANNEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect>
              <Input aria-label="Handle" placeholder="Email, number or profile" value={hand.handle} disabled={disabled} onChange={(e) => setHand({ ...hand, handle: e.target.value })} />
            </div>
            <div><Button size="sm" disabled={disabled || busy} title={disabledTitle(readOnly)} onClick={() => void doHand()}>Add</Button></div>
          </div>
        </Section>
      )}
      {result && <Section title={result.committed ? 'Imported' : 'Preview'}><Result result={result} /><p className="m-0 mt-2 text-xs text-muted-foreground">{resultMessage(result)}</p></Section>}
    </div>
  );
}
