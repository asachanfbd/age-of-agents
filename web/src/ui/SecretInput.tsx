import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { secretField } from '../lib/seoWorkspace';

/** A write-only credential field: a password input that is never filled from the server and reads "Saved" once a value is stored. */
export function SecretInput({ label, saved, value, onChange }: { label: string; saved: boolean; value: string; onChange: (v: string) => void }) {
  const field = secretField(saved);
  return (
    <div className="grid gap-1">
      <Label>{label} {field.badge && <Badge variant="outline" className="ml-1 text-[10px]">{field.badge}</Badge>}</Label>
      <Input type="password" autoComplete="off" value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} aria-label={label} />
    </div>
  );
}
