import { Alert, AlertDescription } from '@/components/ui/alert';

/** A form's own last failure, in the theme's destructive colour on the card background so it reads in light and dark. */
export function FormErrorAlert({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription className="text-destructive">{message}</AlertDescription>
    </Alert>
  );
}
