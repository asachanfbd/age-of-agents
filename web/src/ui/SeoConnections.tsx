import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { serverApi } from '../lib/serverApi';
import { connectDisabledReason, googleClientNotice } from '../lib/googleOAuthClient';
import { SYNC_POLL_MS, connectionCard, progressPercent, shouldPoll, syncWording, volumeLabel } from '../lib/seoWorkspace';
import type { ConnectionCard, ConnectionDto, ServiceId } from '../lib/seoWorkspace';
import { useSeoKeywordsStore } from '../store/seoKeywordsStore';
import { useSeoStore } from '../store/seoStore';
import { useWorldStore } from '../store/worldStore';
import type { ProjectData } from '../types';
import { SecretInput } from './SecretInput';

const TONE_CLASS = { muted: 'text-muted-foreground', good: 'text-success-foreground', warning: 'text-warning-foreground', info: 'text-info-foreground' } as const;

/** Where the Google sign-in client comes from: the app-wide one in global Settings > Google (SEO). */
export function GoogleClientNotice({ saved, onOpenSettings }: { saved: boolean; onOpenSettings: () => void }) {
  const notice = googleClientNotice(saved);
  return (
    <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-4" aria-label="Google OAuth client">
      <p className="m-0 text-sm text-muted-foreground">{notice.text}</p>
      {notice.showOpenSettings && <Button size="sm" variant="outline" onClick={onOpenSettings}>Open Settings</Button>}
    </section>
  );
}

/** Connect and Reconnect for a Google service; both stay disabled, with the reason, until the app-wide client is saved. */
export function GoogleConnectButtons({ actions, saved, onConnect }: { actions: ConnectionCard['actions']; saved: boolean; onConnect: () => void }) {
  const reason = connectDisabledReason(saved);
  return (
    <>
      {actions.includes('connect') && <Button size="sm" disabled={!saved} title={reason} onClick={onConnect}>Connect</Button>}
      {actions.includes('reconnect') && <Button size="sm" variant="outline" disabled={!saved} title={reason} onClick={onConnect}>Reconnect</Button>}
    </>
  );
}

/** Settings → Connections: the Google client notice, the four connection cards and IndexNow. Secrets are write-only fields that read "Saved" afterwards. */
export function SeoConnections({ project }: { project: ProjectData }) {
  const id = project.id;
  const view = useSeoStore((s) => s.connectionsByProject[id]);
  const data = useSeoStore((s) => s.dataByProject[id]);
  const store = useSeoStore.getState;
  const syncRequesting = useSeoStore((s) => s.syncRequesting[id] === true);
  const [message, setMessage] = useState<string | null>(null);
  const [adsToken, setAdsToken] = useState('');
  const [adsCustomer, setAdsCustomer] = useState('');
  const [adsLanguage, setAdsLanguage] = useState('');
  const [adsLocation, setAdsLocation] = useState('');
  const [bingKey, setBingKey] = useState('');
  const [indexNowKey, setIndexNowKey] = useState('');
  const [picker, setPicker] = useState<{ service: 'gsc' | 'ga4'; options: Array<{ id: string; label: string }>; choice: string } | null>(null);
  const [confirm, setConfirm] = useState<{ service: 'gsc' | 'ga4'; property: string } | null>(null);

  // Saving or removing the client in global Settings changes what this screen allows, so it reloads then.
  const globalClientSaved = useWorldStore((s) => s.googleOAuthClientSaved);
  const openSettings = useWorldStore((s) => s.openSettings);

  const refresh = useCallback(async () => { await Promise.all([store().loadConnections(id), store().loadData(id)]); }, [id, store]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (globalClientSaved !== null) void store().loadConnections(id); }, [globalClientSaved, id, store]);
  useEffect(() => {
    if (!shouldPoll(view?.connections, data)) return undefined;
    const timer = setInterval(() => void refresh(), SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [view, data, refresh]);

  const report = (result: { ok: boolean } & { error?: string }, success?: string) => setMessage(result.ok ? success ?? null : result.error ?? 'The request failed');

  async function connectGoogle(service: 'gsc' | 'ga4' | 'ads') {
    const result = await store().startConsent(id, service);
    if (!result.ok) return report(result);
    window.open(result.authUrl, '_blank', 'noopener');
    setMessage('Finish the sign-in in the new tab, then come back here.');
  }
  async function openPicker(service: 'gsc' | 'ga4') {
    try {
      const { properties } = await serverApi.seoProperties(id, service);
      setPicker({ service, options: properties, choice: properties[0]?.id ?? '' });
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load the properties'); }
  }
  async function choose(service: 'gsc' | 'ga4', property: string, confirmed: boolean) {
    const result = await store().selectProperty(id, service, property, confirmed);
    if (!result.ok && result.requiresConfirmation) { setConfirm({ service, property }); return; }
    setPicker(null);
    setConfirm(null);
    report(result, 'Property saved. Press Sync now to load its history.');
  }

  if (!view) return <p className="text-sm text-muted-foreground">Loading connections…</p>;
  const find = (service: ServiceId): ConnectionDto => view.connections.find((c) => c.service === service)!;
  const googleSaved = view.googleClientSaved;

  const renderCard = (service: ServiceId, children?: React.ReactNode) => {
    const c = find(service);
    const card = connectionCard(c);
    const google = service === 'gsc' || service === 'ga4' || service === 'ads';
    return (
      <section className="rounded-xl border bg-card p-4" aria-label={card.title}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="m-0 text-sm font-semibold">{card.title}</h4>
          <span className={`text-xs font-medium ${TONE_CLASS[card.tone]}`}>{card.statusLabel}</span>
        </div>
        {card.detail && <p className="mt-1 text-xs text-muted-foreground">{card.detail}</p>}
        {c.state === 'syncing' && c.progress && <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={progressPercent(c.progress.done, c.progress.total)}><div className="h-full bg-info" style={{ width: `${progressPercent(c.progress.done, c.progress.total)}%` }} /></div>}
        {c.lastSyncAt && <p className="mt-1 text-xs text-muted-foreground">Last successful sync: {new Date(c.lastSyncAt).toLocaleString()}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {google && <GoogleConnectButtons actions={card.actions} saved={googleSaved} onConnect={() => void connectGoogle(service as 'gsc')} />}
          {card.actions.includes('choose-property') && <Button size="sm" variant="outline" onClick={() => void openPicker(service as 'gsc')}>{c.property ? 'Change property' : 'Choose property'}</Button>}
          {card.actions.includes('sync-now') && <Button size="sm" variant="outline" disabled={card.syncNowDisabled || syncRequesting} onClick={() => void store().syncNow(id).then((r) => report(r))}>Sync now</Button>}
          {card.actions.includes('disconnect') && <Button size="sm" variant="ghost" onClick={() => void store().disconnect(id, service).then((r) => report(r, 'Disconnected. Stored data is kept.'))}>Disconnect</Button>}
        </div>
        {children}
      </section>
    );
  };

  return (
    <div className="grid max-w-3xl gap-4" aria-label="SEO connections">
      <p className="m-0 text-sm text-muted-foreground">{view.siteUrl}. {syncWording(false)}</p>
      {message && <Alert><AlertDescription>{message}</AlertDescription></Alert>}

      <GoogleClientNotice saved={googleSaved} onOpenSettings={() => openSettings('google-seo')} />

      {renderCard('gsc')}
      {renderCard('ga4')}
      {renderCard('ads', <>
        {find('ads').state !== 'not-connected' && (
          <div className="mt-3 grid gap-2">
            <p className="m-0 text-xs text-muted-foreground">{volumeLabel(find('ads').volume)}. Keyword Planner needs a Google Ads account and a developer token Google has approved.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <SecretInput label="Developer token" saved={view.adsDeveloperTokenSaved} value={adsToken} onChange={setAdsToken} />
              <div className="grid gap-1"><Label>Customer id</Label><Input value={adsCustomer} placeholder={find('ads').customerId ?? '123-456-7890'} onChange={(e) => setAdsCustomer(e.target.value)} aria-label="Customer id" /></div>
            </div>
            <Button size="sm" variant="outline" className="w-fit" disabled={!adsToken.trim() || !(adsCustomer.trim() || find('ads').customerId)}
              onClick={() => void store().connectAds(id, adsToken.trim(), (adsCustomer || find('ads').customerId || '').trim()).then((r) => { if (r.ok) setAdsToken(''); report(r, 'Google Ads checked.'); })}>Check access</Button>
            <p className="m-0 mt-2 text-xs text-muted-foreground">Keyword research asks Keyword Planner about one language and one location. Use the numeric Google Ads ids (English is 1000, United States is 2840).</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1"><Label>Language id</Label><Input value={adsLanguage} inputMode="numeric" placeholder={view.keywordMarket?.languageId ?? '1000'} onChange={(e) => setAdsLanguage(e.target.value)} aria-label="Language id" /></div>
              <div className="grid gap-1"><Label>Location id</Label><Input value={adsLocation} inputMode="numeric" placeholder={view.keywordMarket?.locationId ?? '2840'} onChange={(e) => setAdsLocation(e.target.value)} aria-label="Location id" /></div>
            </div>
            <Button size="sm" variant="outline" className="w-fit" disabled={!(adsLanguage.trim() || view.keywordMarket) || !(adsLocation.trim() || view.keywordMarket)}
              onClick={() => void useSeoKeywordsStore.getState().setMarket(id, (adsLanguage || view.keywordMarket?.languageId || '').trim(), (adsLocation || view.keywordMarket?.locationId || '').trim()).then(async (r) => { if (r.ok) { setAdsLanguage(''); setAdsLocation(''); await store().loadConnections(id); } report(r, 'Language and location saved.'); })}>Save language and location</Button>
          </div>
        )}
      </>)}
      {renderCard('bing', (
        <div className="mt-3 grid gap-2">
          <SecretInput label="Bing Webmaster API key" saved={view.bingKeySaved} value={bingKey} onChange={setBingKey} />
          <Button size="sm" variant="outline" className="w-fit" disabled={!bingKey.trim()} onClick={() => void store().connectBing(id, bingKey.trim()).then((r) => { if (r.ok) setBingKey(''); report(r, r.ok && r.message ? r.message : 'Bing checked.'); })}>Save and check</Button>
        </div>
      ))}
      {renderCard('indexnow', (
        <div className="mt-3 grid gap-2">
          <SecretInput label="IndexNow key" saved={view.indexNowKeySaved} value={indexNowKey} onChange={setIndexNowKey} />
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!indexNowKey.trim()} onClick={() => void store().saveIndexNow(id, indexNowKey.trim()).then((r) => { if (r.ok) setIndexNowKey(''); report(r, 'IndexNow key saved.'); })}>Save key</Button>
            <Button size="sm" variant="ghost" onClick={() => void store().saveIndexNow(id).then((r) => report(r, 'A new IndexNow key was generated.'))}>Generate one</Button>
          </div>
        </div>
      ))}

      {view.previousProperties.length > 0 && (
        <p className="m-0 text-xs text-muted-foreground">Data from previous properties is kept: {view.previousProperties.map((p) => p.property).join(', ')}.</p>
      )}

      <Dialog open={picker !== null} onOpenChange={(open) => { if (!open) setPicker(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Choose the property for this site</DialogTitle><DialogDescription>These are the properties your Google account can see.</DialogDescription></DialogHeader>
          <div className="grid max-h-64 gap-1 overflow-y-auto" role="radiogroup" aria-label="Properties">
            {picker?.options.map((o) => (
              <label key={o.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><input type="radio" name="property" checked={picker.choice === o.id} onChange={() => setPicker({ ...picker, choice: o.id })} />{o.label}</label>
            ))}
            {picker && !picker.options.length && <p className="m-0 text-sm text-muted-foreground">This Google account has no properties.</p>}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setPicker(null)}>Cancel</Button><Button disabled={!picker?.choice} onClick={() => picker && void choose(picker.service, picker.choice, false)}>Use this property</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Change the property?</DialogTitle><DialogDescription>The data already stored is kept and marked as belonging to the previous property. Syncing continues with {confirm?.property}.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setConfirm(null)}>Keep the current property</Button><Button onClick={() => confirm && void choose(confirm.service, confirm.property, true)}>Change property</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
