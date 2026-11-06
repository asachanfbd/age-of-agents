import { useWorldStore } from '../store/worldStore';
import { CommandLogPopup } from './project-popup/commands/CommandLogPopup';

/**
 * The command log popup opened from the footer's Commands list or a command-completed notification.
 * Mounted at the app root, after the project popup, so it stacks over whatever is open without opening
 * or switching a project; Minimize or Close returns to exactly what was underneath. Re-run swaps in the new run.
 */
export function FooterCommandLog() {
  const runId = useWorldStore((s) => s.footerCommandLogRunId);
  const close = useWorldStore((s) => s.closeFooterCommandLog);
  const open = useWorldStore((s) => s.openFooterCommandLog);
  if (!runId) return null;
  return <CommandLogPopup key={runId} runId={runId} onClose={close} onRerun={(newRunId) => void open(newRunId)} />;
}
