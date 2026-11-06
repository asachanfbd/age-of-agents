import { videoDeps } from './videoDeps.ts';
import { charCount } from './validate.ts';

/** Bracketed-paste markers. Both CLIs turn this mode on, so the text between them arrives as one paste, however it is read. */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** The one call the helper needs from the terminal host. */
export interface SessionInput { write(id: string, data: string): void }

type SetTimer = (fn: () => void, ms: number) => unknown;

/**
 * Makes text safe to type into the agent's terminal: line breaks and tabs become spaces, so the text cannot press Enter
 * early, and escape sequences and control characters are dropped, so it cannot end a paste or send Ctrl-C.
 */
export function terminalSafe(text: string): string {
  return text
    .replace(/\r\n|[\r\n\t]/g, ' ')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/**
 * Types `text` into a live session as if the owner pasted it, then presses Enter after `delayMs`. The text goes as one
 * bracketed paste, so the CLI never has to guess from read sizes where a paste starts (an unbracketed write over one
 * 1,024-byte read was split into a paste block and typed text, and the paste block was lost). Enter is a separate write
 * after the pause, so the CLI does not take it as part of the paste. Returns how many characters were pasted.
 */
export async function typeIntoSession(host: SessionInput, id: string, text: string, delayMs: number, setTimer: SetTimer = videoDeps().setTimer): Promise<number> {
  const safe = terminalSafe(text);
  host.write(id, `${PASTE_START}${safe}${PASTE_END}`);
  await new Promise<void>((resolve) => { setTimer(resolve, delayMs); });
  host.write(id, '\r');
  return charCount(safe);
}
