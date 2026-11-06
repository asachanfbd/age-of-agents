import { useSyncExternalStore } from 'react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { getSoundsMuted, setSoundsMuted, subscribeSoundsMuted } from '../lib/soundPreference';
import {
  getThemePreference,
  setThemePreference,
  subscribeThemePreference,
  type ThemePreference,
} from '../lib/themePreference';

const THEME_OPTIONS: { value: ThemePreference; label: string; description: string }[] = [
  { value: 'light', label: 'Light', description: 'Keep the village in daylight.' },
  { value: 'dark', label: 'Dark', description: 'Use a moonlit night scene.' },
  { value: 'system', label: 'System', description: 'Follow your device appearance.' },
  { value: 'daytime', label: 'Sync with daytime', description: 'Follow the real day and night cycle.' },
];

export function PreferencesSettings() {
  const theme = useSyncExternalStore(subscribeThemePreference, getThemePreference, getThemePreference);
  const soundsMuted = useSyncExternalStore(subscribeSoundsMuted, getSoundsMuted, getSoundsMuted);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-sm font-semibold">Preferences</h3>
        <p className="mt-1 text-xs text-muted-foreground">Choose how the village looks and sounds.</p>
      </div>

      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-2.5 text-sm font-semibold">Theme</legend>
        <RadioGroup
          value={theme}
          onValueChange={(value) => setThemePreference(value as ThemePreference)}
          className="grid max-w-xl gap-2"
        >
          {THEME_OPTIONS.map((option) => (
            <Label
              key={option.value}
              htmlFor={`theme-${option.value}`}
              className="flex min-h-16 cursor-pointer items-center gap-3 rounded-lg border border-border bg-muted/20 p-3.5 font-normal transition-colors hover:border-primary/50 hover:bg-muted/40 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/10"
            >
              <RadioGroupItem value={option.value} id={`theme-${option.value}`} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="text-sm font-semibold">{option.label}</strong>
                <span className="text-xs leading-relaxed text-muted-foreground">{option.description}</span>
              </span>
              {option.value === 'daytime' && <Badge variant="outline" className="text-[10px]">Default</Badge>}
            </Label>
          ))}
        </RadioGroup>
      </fieldset>

      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-2.5 text-sm font-semibold">Sounds</legend>
        <Label
          htmlFor="mute-sounds"
          className="flex max-w-xl min-h-16 cursor-pointer items-center gap-3 rounded-lg border border-border bg-muted/20 p-3.5 font-normal transition-colors hover:border-primary/50 hover:bg-muted/40"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-sm font-semibold">Mute sounds</strong>
            <span className="text-xs leading-relaxed text-muted-foreground">Silence the alert when a task needs you and the chime when one completes.</span>
          </span>
          <Switch id="mute-sounds" checked={soundsMuted} onCheckedChange={setSoundsMuted} />
        </Label>
      </fieldset>
    </div>
  );
}
