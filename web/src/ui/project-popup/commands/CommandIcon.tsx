import { FlaskConical, Hammer, Play, SpellCheck, Terminal } from 'lucide-react';
import { commandIconKey } from '../../../lib/commandIcon';
import type { CommandIconKey } from '../../../lib/commandIcon';

const ICONS: Record<CommandIconKey, typeof Play> = { build: Hammer, test: FlaskConical, lint: SpellCheck, run: Play, generic: Terminal };

/** The small icon that goes with a command's name — hammer for a build, flask for tests, and so on. */
export function CommandIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[commandIconKey(name)];
  return <Icon className={className} aria-hidden="true" />;
}
