import { Alert, AlertDescription } from '@/components/ui/alert';
import type { RowStatus } from '../../lib/crmProspects';
import { RelativeTime } from '../design/RelativeTime';

export function ErrorNote({ message }: { message: string | null }) {
  return message ? <Alert variant="destructive" className="my-2"><AlertDescription>{message}</AlertDescription></Alert> : null;
}

/** A Prospects status label, with the resurface time of a no-response contact in the Building time zone. */
export function StatusText({ status, timeZone }: { status: RowStatus; timeZone?: string }) {
  return <>{status.label}{status.resurfaceAt ? <> · resurfaces <RelativeTime at={status.resurfaceAt} timeZone={timeZone} /></> : null}</>;
}
