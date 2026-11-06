import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { canSaveGoogleClient } from '../lib/googleOAuthClient';
import { useWorldStore } from '../store/worldStore';
import { SecretInput } from './SecretInput';

export interface GoogleSeoSettingsViewProps {
  saved: boolean;
  clientId: string;
  clientSecret: string;
  message: string | null;
  busy: boolean;
  confirmRemove: boolean;
  onClientId: (value: string) => void;
  onClientSecret: (value: string) => void;
  onSave: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}

/** Global Settings > Google (SEO): the one Google Cloud OAuth client every SEO Building signs in with. */
export function GoogleSeoSettingsView(props: GoogleSeoSettingsViewProps) {
  const { saved, clientId, clientSecret, message, busy, confirmRemove } = props;
  return (
    <section className="space-y-4" aria-label="Google OAuth client">
      <div>
        <h3 className="m-0 text-sm font-semibold">Your Google Cloud OAuth client</h3>
        <p className="mt-1 text-sm text-muted-foreground">Create an OAuth client of type “Desktop app” in your Google Cloud project, then paste its id and secret once. Every SEO Building uses it to connect Search Console, Analytics and Google Ads. Both values are stored on this machine and never shown again.</p>
      </div>
      {message && <Alert><AlertDescription>{message}</AlertDescription></Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <SecretInput label="Client id" saved={saved} value={clientId} onChange={props.onClientId} />
        <SecretInput label="Client secret" saved={saved} value={clientSecret} onChange={props.onClientSecret} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !canSaveGoogleClient(clientId, clientSecret)} onClick={props.onSave}>{saved ? 'Replace' : 'Save'}</Button>
        {saved && <Button size="sm" variant="ghost" disabled={busy} onClick={props.onAskRemove}>Remove</Button>}
      </div>
      <Dialog open={confirmRemove} onOpenChange={(open) => { if (!open) props.onCancelRemove(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove the Google client?</DialogTitle>
            <DialogDescription>Connect will be disabled in SEO Buildings until a client is saved again. Existing connections stay, but their next refresh asks you to connect again.</DialogDescription>
          </DialogHeader>
          <DialogFooter><Button variant="outline" onClick={props.onCancelRemove}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={props.onRemove}>Remove</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function GoogleSeoSettings() {
  const saved = useWorldStore((s) => s.googleOAuthClientSaved) === true;
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => { void useWorldStore.getState().loadGoogleOAuthClient(); }, []);

  async function run(action: () => Promise<string | null>, success: string) {
    setBusy(true);
    const error = await action();
    setBusy(false);
    setMessage(error ?? success);
    return error === null;
  }
  async function save() {
    if (await run(() => useWorldStore.getState().saveGoogleOAuthClient(clientId, clientSecret), 'Google client saved.')) { setClientId(''); setClientSecret(''); }
  }
  async function remove() {
    setConfirmRemove(false);
    await run(() => useWorldStore.getState().removeGoogleOAuthClient(), 'Google client removed.');
  }

  return (
    <GoogleSeoSettingsView
      saved={saved} clientId={clientId} clientSecret={clientSecret} message={message} busy={busy} confirmRemove={confirmRemove}
      onClientId={setClientId} onClientSecret={setClientSecret} onSave={() => void save()}
      onAskRemove={() => setConfirmRemove(true)} onCancelRemove={() => setConfirmRemove(false)} onRemove={() => void remove()}
    />
  );
}
