import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AgentsSettings } from './AgentsSettings';
import { GithubAccountsSettings } from './GithubAccountsSettings';
import { GoogleSeoSettings } from './GoogleSeoSettings';
import { useWorldStore } from '../store/worldStore';
import type { GlobalSettingsSection } from '../store/worldStore';
import { PreferencesSettings } from './PreferencesSettings';

/**
 * App-wide settings — a full-height side panel (shadcn `Sheet`) with its own
 * top tabs, replacing the status bar's old "Agents" popover. `SECTIONS` is a
 * plain list so a future section is just another entry plus a case below.
 * Which tab is open lives in the world store, so another screen (an SEO
 * Building's Connections) can open the panel on a given tab.
 */
const SECTIONS: { key: GlobalSettingsSection; label: string }[] = [
  { key: 'agents', label: 'Coding agents' },
  { key: 'preferences', label: 'Preferences' },
  { key: 'github', label: 'GitHub accounts' },
  { key: 'google-seo', label: 'Google (SEO)' },
];

export function SettingsPanel() {
  const section = useWorldStore((s) => s.settingsSection);
  const openSettings = useWorldStore((s) => s.openSettings);
  const closeSettings = useWorldStore((s) => s.closeSettings);
  if (section === null) return null;

  return (
    <Sheet open onOpenChange={(open) => { if (!open) closeSettings(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" aria-label="Settings">
        <SheetHeader className="border-b border-border px-6 py-4 text-left">
          <SheetTitle>Settings</SheetTitle>
        </SheetHeader>

        <Tabs
          value={section}
          onValueChange={(value) => openSettings(value as GlobalSettingsSection)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-6 mt-4 w-fit">
            {SECTIONS.map(({ key, label }) => (
              <TabsTrigger key={key} value={key}>{label}</TabsTrigger>
            ))}
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <TabsContent value="agents" className="mt-0">
              <AgentsSettings />
            </TabsContent>
            <TabsContent value="preferences" className="mt-0">
              <PreferencesSettings />
            </TabsContent>
            <TabsContent value="github" className="mt-0">
              <GithubAccountsSettings />
            </TabsContent>
            <TabsContent value="google-seo" className="mt-0">
              <GoogleSeoSettings />
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
