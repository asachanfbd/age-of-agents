/**
 * Turns ANSI SGR (color/bold/underline/…) escape codes embedded in a command's raw stdout/stderr
 * into React-renderable styled segments. Without this, `CommandLogPopup`'s `<pre>` shows a colored
 * CLI's own output (webpack, npm, most build tools) as literal noise — "ESC[1mESC[32mmain.jsESC[39mESC[22m"
 * — instead of bold green text, since a plain scrollback view has nothing that interprets escape
 * codes the way a real terminal does.
 *
 * Only SGR sequences (`ESC [ params m` — the ones that set color/weight/decoration) are turned into
 * styling; every other escape sequence a CLI might emit (cursor movement, line erase, OSC window
 * titles, …) is recognized and dropped silently rather than rendered as visible garbage — this is a
 * static, top-to-bottom log view with no cursor to move, so "erase the current line and rewrite it"
 * has no equivalent here. That's a deliberate scope cut (no terminal emulation), not a bug: a
 * spinner or progress bar that repaints in place via those codes will just show every frame it ever
 * printed, in order.
 */

export interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: 'bold';
  fontStyle?: 'italic';
  textDecoration?: string;
  opacity?: number;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const ESC = '\x1b';
const BEL = '\x07';

/** The 16 standard ANSI colors (0-7 normal, 8-15 bright) — codes 30-37/90-97 (foreground) and 40-47/100-107 (background) index into this. Tuned for a dark log background (`.command-log__output`), not a light terminal. */
const BASE_PALETTE = [
  '#4b4b4b', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#c7ccd1',
  '#6b7076', '#f4808c', '#b5e08c', '#f0d089', '#7fc1f5', '#dd97ea', '#7fd4de', '#ffffff',
];

/** Maps a `38;5;N` / `48;5;N` 256-color index to an RGB string — the standard xterm 256-color layout (0-15 the base palette, 16-231 a 6×6×6 cube, 232-255 a grayscale ramp), computed rather than tabulated. */
function ansi256ToRgb(n: number): string {
  if (n < 16) return BASE_PALETTE[n] ?? BASE_PALETTE[0]!;
  if (n < 232) {
    const i = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(Math.floor(i / 36))}, ${level(Math.floor((i % 36) / 6))}, ${level(i % 6)})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

/** Adds or removes one `text-decoration` keyword (underline/line-through can both be active at once) without disturbing the other. */
function withDecoration(current: string | undefined, value: string, add: boolean): string | undefined {
  const parts = new Set((current ?? '').split(' ').filter(Boolean));
  if (add) parts.add(value); else parts.delete(value);
  return parts.size > 0 ? [...parts].join(' ') : undefined;
}

/** Applies one SGR escape's `;`-separated numeric params to a running style, returning the next one. `params` may include extended-color sub-sequences (`38;5;N`, `38;2;R;G;B`), which consume the following entries in the same loop. */
function applySgr(style: AnsiStyle, params: string[]): AnsiStyle {
  if (params.length === 0 || (params.length === 1 && params[0] === '')) return {}; // ESC[m === ESC[0m: full reset
  const next = { ...style };
  for (let i = 0; i < params.length; i++) {
    const code = Number(params[i]);
    if (!Number.isInteger(code)) continue;
    if (code === 0) { for (const key of Object.keys(next)) delete (next as Record<string, unknown>)[key]; }
    else if (code === 1) next.fontWeight = 'bold';
    else if (code === 2) next.opacity = 0.7;
    else if (code === 3) next.fontStyle = 'italic';
    else if (code === 4) next.textDecoration = withDecoration(next.textDecoration, 'underline', true);
    else if (code === 9) next.textDecoration = withDecoration(next.textDecoration, 'line-through', true);
    else if (code === 22) { delete next.fontWeight; delete next.opacity; }
    else if (code === 23) delete next.fontStyle;
    else if (code === 24) next.textDecoration = withDecoration(next.textDecoration, 'underline', false);
    else if (code === 29) next.textDecoration = withDecoration(next.textDecoration, 'line-through', false);
    else if (code === 39) delete next.color;
    else if (code === 49) delete next.backgroundColor;
    else if (code >= 30 && code <= 37) next.color = BASE_PALETTE[code - 30];
    else if (code >= 90 && code <= 97) next.color = BASE_PALETTE[8 + (code - 90)];
    else if (code >= 40 && code <= 47) next.backgroundColor = BASE_PALETTE[code - 40];
    else if (code >= 100 && code <= 107) next.backgroundColor = BASE_PALETTE[8 + (code - 100)];
    else if (code === 38 || code === 48) {
      const mode = params[i + 1];
      let color: string | undefined;
      if (mode === '5') { color = ansi256ToRgb(Number(params[i + 2])); i += 2; }
      else if (mode === '2') { color = `rgb(${params[i + 2]}, ${params[i + 3]}, ${params[i + 4]})`; i += 4; }
      if (color) { if (code === 38) next.color = color; else next.backgroundColor = color; }
    }
    // Everything else (7 inverse, 8 hidden, ...) has no representation worth adding for a log viewer — ignored.
  }
  return next;
}

/**
 * Splits raw command output into plain-text runs, each tagged with the SGR style active at that
 * point — render each as a `<span style={...}>`. Called on the full accumulated `run.output` each
 * time (not per streamed chunk), so a multi-byte escape sequence split across two WS chunks is
 * always whole by the time it's parsed here.
 */
export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let styleIsEmpty = true; // avoids allocating/attaching an empty {} style to every plain-text segment
  let textStart = 0;
  let i = 0;

  function flush(end: number): void {
    if (end > textStart) segments.push({ text: input.slice(textStart, end), style: styleIsEmpty ? {} : { ...style } });
  }

  while (i < input.length) {
    if (input[i] !== ESC) { i++; continue; }
    flush(i);

    if (input[i + 1] === '[') {
      // CSI: ESC [ parameter-bytes(0-9;?) intermediate-bytes( -/) final-byte(@-~) — ECMA-48.
      let j = i + 2;
      while (j < input.length && /[0-9;?]/.test(input[j]!)) j++;
      while (j < input.length && input[j]! >= ' ' && input[j]! <= '/') j++;
      const final = input[j];
      if (final === undefined) { i = input.length; } // unterminated at buffer end — drop the rest
      else {
        if (final === 'm') {
          style = applySgr(style, input.slice(i + 2, j).split(';'));
          styleIsEmpty = Object.keys(style).length === 0;
        }
        // Any other final byte (K erase-line, A/B cursor moves, H/J screen control, ...) is a
        // no-op here — recognized and dropped, not rendered as literal text.
        i = j + 1;
      }
    } else if (input[i + 1] === ']') {
      // OSC: ESC ] ... terminated by BEL or ESC \ (e.g. a shell setting the window title).
      let j = i + 2;
      while (j < input.length && input[j] !== BEL && !(input[j] === ESC && input[j + 1] === '\\')) j++;
      i = input[j] === BEL ? j + 1 : Math.min(j + 2, input.length);
    } else {
      i += 2; // some other two-byte escape (e.g. ESC 7 / ESC 8 cursor save/restore) — skip it
    }
    textStart = i;
  }
  flush(input.length);
  return segments;
}
