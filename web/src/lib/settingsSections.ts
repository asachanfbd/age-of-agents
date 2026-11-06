export const SETTINGS_SECTIONS = ['general', 'workflow', 'git', 'commands', 'schedules', 'connections', 'activity', 'storage'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * Which Settings sections a Building offers: General (name and removal) for every type; Git provider, Workflow and Commands belong to repository types; Schedules,
 * Connections and Activity are the generic areas every known type gets; Storage belongs to types that keep bulk data.
 * Before the type is known only General and the repository sections show.
 */
export function settingsSectionsFor(type: { repository: boolean; hasStorage: boolean } | undefined): SettingsSection[] {
  if (!type) return ['general', 'workflow', 'git', 'commands'];
  return [
    'general',
    ...(type.repository ? (['workflow', 'git', 'commands'] as const) : []),
    'schedules',
    'connections',
    'activity',
    ...(type.hasStorage ? (['storage'] as const) : []),
  ];
}

/** The section to show: the requested one when offered, else the first offered. */
export function effectiveSection(requested: SettingsSection, offered: SettingsSection[]): SettingsSection | null {
  return offered.includes(requested) ? requested : offered[0] ?? null;
}
