import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NO_SECRETS_TEXT, checkThreshold, formatBytes, retentionConfirmText, storageSummary } from '../../lib/buildingStorage';
import type { StorageStatusDto } from '../../lib/buildingStorage';
import { serverApi } from '../../lib/serverApi';
import { useStorageJob } from '../../lib/useStorageJob';
import type { ProjectData } from '../../types';
import { JobProgress } from '../JobProgress';

/** Settings -> Storage for a Building whose type keeps bulk data: size vs threshold, retention, backup, ingestion state and secrets. */
export function StorageSettings({ project }: { project: ProjectData }) {
  const [status, setStatus] = useState<StorageStatusDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [thresholdText, setThresholdText] = useState('');
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exportedFile, setExportedFile] = useState<string | null>(null);
  const [confirmingRetention, setConfirmingRetention] = useState(false);

  const reload = useCallback(() => {
    serverApi.getStorage(project.id)
      .then((next) => { setStatus(next); setLoadError(null); })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Could not load storage'));
  }, [project.id]);
  const { job, error: jobError, start, cancel } = useStorageJob(project.id, reload);

  useEffect(() => { reload(); }, [reload]);

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try { await action(); reload(); } catch (e) { setActionError(e instanceof Error ? e.message : 'The request failed'); }
  }

  async function saveThreshold(e: React.FormEvent) {
    e.preventDefault();
    const checked = checkThreshold(thresholdText);
    if ('error' in checked) { setThresholdError(checked.error); return; }
    setThresholdError(null);
    await run(async () => { setStatus(await serverApi.setStorageThreshold(project.id, checked.bytes)); setThresholdText(''); });
  }

  async function exportBackup() {
    await run(async () => { setExportedFile((await serverApi.exportStorage(project.id)).file); });
  }

  if (!status) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <h3 className="text-base font-semibold tracking-tight">Storage</h3>
        <p className={`mt-3 text-sm ${loadError ? 'text-destructive' : 'italic text-muted-foreground'}`} role={loadError ? 'alert' : undefined}>{loadError ?? 'Loading...'}</p>
      </div>
    );
  }

  const retentionRunning = job?.kind === 'retention' && job.status === 'running';
  const summary = storageSummary(status, retentionRunning);
  const stopped = status.ingestionStoppedReason !== null && status.readOnlyReason === null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <h3 className="text-base font-semibold tracking-tight">Storage</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">How much space this Building's data uses, and what happens as it grows.</p>

      {summary.banner && (
        <Alert variant={stopped || status.readOnlyReason ? 'destructive' : 'default'} className="mt-4 flex items-center justify-between gap-3" role="status">
          <AlertDescription>{summary.banner}</AlertDescription>
          {stopped && <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void run(() => serverApi.resumeIngestion(project.id))}>Resume ingestion</Button>}
        </Alert>
      )}
      {actionError && <p className="mt-3 text-sm text-destructive" role="alert">{actionError}</p>}

      <section className="mt-5 rounded-xl border bg-card p-4 shadow-sm" aria-label="Size">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium">{summary.size} of {summary.threshold} warning threshold</span>
          <span className={`text-xs ${summary.warning ? 'font-semibold text-warning-foreground' : 'text-muted-foreground'}`}>{summary.warning ? 'Over the threshold' : `${summary.percent}% used`}</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.percent}>
          <div className={`h-full rounded-full ${summary.warning ? 'bg-warning' : 'bg-primary'}`} style={{ width: `${summary.percent}%` }} />
        </div>
        <form className="mt-4 flex flex-wrap items-start gap-2" onSubmit={(e) => void saveThreshold(e)}>
          <div>
            <Input value={thresholdText} onChange={(e) => setThresholdText(e.target.value)} placeholder={`Warn at, e.g. ${formatBytes(status.warningBytes)}`} aria-label="Warning threshold" aria-invalid={thresholdError ? true : undefined} className="w-56" />
            {thresholdError && <p className="mt-1 text-xs text-destructive" role="alert">{thresholdError}</p>}
          </div>
          <Button type="submit" variant="outline" size="sm" className="mt-0.5">Save threshold</Button>
        </form>
      </section>

      <section className="mt-4 rounded-xl border bg-card p-4 shadow-sm" aria-label="Retention">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-semibold">Retention</h4>
            <p className="mt-0.5 text-sm text-muted-foreground">{summary.retentionText}</p>
          </div>
          <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={!summary.canRunRetention || confirmingRetention} onClick={() => setConfirmingRetention(true)}>Run now</Button>
        </div>
        {confirmingRetention && status.retention.rule && (
          <Alert role="alertdialog" className="mt-3">
            <AlertDescription>
              <p>{retentionConfirmText(status.retention.rule, new Date())}</p>
              <div className="mt-2 flex gap-2">
                <Button type="button" size="sm" variant="destructive" onClick={() => { setConfirmingRetention(false); void start(() => serverApi.runRetention(project.id)); }}>Delete old rows</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setConfirmingRetention(false)}>Keep them</Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {job?.kind === 'retention' && <JobProgress job={job} onCancel={() => void cancel()} />}
        {jobError && <p className="mt-2 text-sm text-destructive" role="alert">{jobError}</p>}
      </section>

      <section className="mt-4 rounded-xl border bg-card p-4 shadow-sm" aria-label="Backup">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-semibold">Backup</h4>
            <p className="mt-0.5 text-sm text-muted-foreground">Last backup: {summary.backupText}</p>
            {exportedFile && <p className="mt-0.5 text-xs text-muted-foreground">Saved to {exportedFile}</p>}
          </div>
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void exportBackup()}>Export backup</Button>
        </div>
      </section>

      <SecretsList projectId={project.id} secrets={status.secrets} onSaved={reload} />
    </div>
  );
}

/** Saved secrets show only "saved"; a new value lives in the input's own state until it is sent, then the input is cleared. */
function SecretsList({ projectId, secrets, onSaved }: { projectId: string; secrets: StorageStatusDto['secrets']; onSaved: () => void }) {
  const [listed, setListed] = useState<StorageStatusDto['secrets']>(secrets);
  useEffect(() => { serverApi.listSecrets(projectId).then(setListed).catch(() => setListed(secrets)); }, [projectId, secrets]);

  return (
    <section className="mt-4 rounded-xl border bg-card p-4 shadow-sm" aria-label="Secrets">
      <h4 className="text-sm font-semibold">Secrets</h4>
      <p className="mt-0.5 text-sm text-muted-foreground">Values are stored on the daemon and never shown again.</p>
      {listed.length === 0 && <p className="mt-3 text-sm italic text-muted-foreground">{NO_SECRETS_TEXT}</p>}
      <ul className="mt-3 space-y-3">
        {listed.map(({ key, hasSecret }) => <SecretRow key={key} projectId={projectId} name={key} hasSecret={hasSecret} onSaved={onSaved} />)}
      </ul>
    </section>
  );
}

function SecretRow({ projectId, name, hasSecret, onSaved }: { projectId: string; name: string; hasSecret: boolean; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(hasSecret);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!value) return;
    try {
      await serverApi.saveSecret(projectId, name, value);
      setValue('');
      setSaved(true);
      setError(null);
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save the secret'); }
  }

  return (
    <li>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => void save(e)}>
        <span className="w-40 shrink-0 truncate text-sm font-medium">{name}</span>
        <span className="w-16 shrink-0 text-xs text-muted-foreground">{saved ? 'saved' : 'not set'}</span>
        <Input type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={saved ? 'Replace value' : 'Enter value'} aria-label={`${name} value`} className="w-56" />
        <Button type="submit" variant="outline" size="sm" disabled={!value}>{saved ? 'Replace' : 'Save'}</Button>
      </form>
      {error && <p className="mt-1 text-xs text-destructive" role="alert">{error}</p>}
    </li>
  );
}
