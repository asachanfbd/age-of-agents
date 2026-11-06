import { Button } from '@/components/ui/button';
import { jobSummary } from '../lib/buildingStorage';
import type { StorageJobDto } from '../lib/buildingStorage';

/** A job's progress bar and status line, with Cancel while it runs. */
export function JobProgress({ job, onCancel }: { job: StorageJobDto; onCancel: () => void }) {
  const summary = jobSummary(job);
  return (
    <div className="mt-3 rounded-lg border bg-muted/30 p-3" aria-label="Job progress">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">{summary.label}</span>
        {summary.canCancel && <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>}
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.percent}>
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${summary.percent}%` }} />
      </div>
    </div>
  );
}
