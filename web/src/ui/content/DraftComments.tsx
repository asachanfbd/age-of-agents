import { Check, MessageSquarePlus } from 'lucide-react';
import { useId } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { commentCounter, commentProblem, draftLines, lineWarning } from '../../lib/scriptComments';
import type { CommentBox, CommentsState, DraftLine, SentNote } from '../../lib/scriptComments';
import { RelativeTime } from '../design/RelativeTime';
import { ErrorNote } from '../crm/shared';

/** What the Result pane needs to offer line comments; the state lives in `StudioPane`. */
export interface LineComments {
  state: CommentsState;
  /** Why comments are disabled, `hidden` when they are not offered, or null. */
  block: 'hidden' | string | null;
  onOpen: (line: number, lineText: string) => void;
  onEdit: (line: number, text: string) => void;
  onCancel: (line: number) => void;
  /** Resolves true once the daemon took the comment. */
  onSend: (line: number, lineText: string, comment: string) => Promise<boolean>;
}

const INDENT = 'ml-12 mr-2';

function SentNotes({ notes, now }: { notes: SentNote[]; now?: number }) {
  return (
    <>
      {notes.map((note, i) => (
        <div key={i} className={cn(INDENT, 'my-1 grid gap-0.5 border-l-2 border-border pl-2 text-xs text-muted-foreground')} data-sent>
          <span className="flex items-center gap-1"><Check aria-hidden="true" className="size-3" />Sent · <RelativeTime at={note.at} now={now} /></span>
          <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{note.comment}</p>
        </div>
      ))}
    </>
  );
}

function CommentForm({ line, box, lines, block, buttonId, comments }: { line: number; box: CommentBox; lines: DraftLine[]; block: string | null; buttonId: string; comments: LineComments }) {
  const id = useId();
  const warning = lineWarning(box, lines, line);
  const problem = commentProblem(box.text);
  const counter = commentCounter(box.text);
  const sending = box.status === 'sending';
  const canSend = !sending && !block && problem === null && !warning?.blocksSend;
  const focusButton = () => document.getElementById(buttonId)?.focus();
  const cancel = () => { comments.onCancel(line); focusButton(); };
  const send = () => {
    if (!canSend) return;
    void comments.onSend(line, lines[line - 1]!.text, box.text).then((ok) => { if (ok) focusButton(); });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  return (
    <div className={cn(INDENT, 'my-1 grid gap-2 rounded-card border border-border bg-background p-2')} data-comment-box={line}>
      <label htmlFor={id} className="text-xs font-medium">Comment on line {line}</label>
      {warning && (
        <p role="status" className="m-0 rounded-card border border-warning/40 bg-warning/10 p-1.5 text-xs [overflow-wrap:anywhere]" data-line-warning>
          {warning.blocksSend ? warning.text : <>This line changed in the new draft. It now reads: “{warning.text}”</>}
        </p>
      )}
      <textarea
        id={id} value={box.text} rows={3} disabled={sending} aria-invalid={counter.over || undefined}
        onChange={(e) => comments.onEdit(line, e.target.value)} onKeyDown={onKeyDown}
        className="min-h-16 w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm [overflow-wrap:anywhere] disabled:opacity-60 aria-[invalid=true]:border-destructive"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cn('text-xs tabular-nums', counter.over ? 'text-destructive' : 'text-muted-foreground')} data-counter>{counter.text}</span>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={sending} onClick={cancel}>Cancel</Button>
          <Button type="button" size="sm" disabled={!canSend} title={block ?? undefined} onClick={send}>{sending ? 'Sending…' : 'Send'}</Button>
        </div>
      </div>
      {problem && problem !== 'empty' && <p className="m-0 text-xs text-destructive">{problem}</p>}
      <ErrorNote message={box.error} />
    </div>
  );
}

/** The draft one line per row, each non-blank line with a comment button that opens a box under it. */
export function CommentableDraft({ text, comments, now }: { text: string; comments: LineComments; now?: number }) {
  const prefix = useId();
  const lines = draftLines(text);
  const block = comments.block === 'hidden' ? null : comments.block;
  const buttonId = (n: number) => `${prefix}-line-${n}`;
  // A box whose line a newer, shorter draft dropped still shows, so its text is not lost.
  const extra = Object.keys(comments.state.boxes).map(Number).filter((n) => n > lines.length).sort((a, b) => a - b);
  return (
    <ol className="m-0 grid list-none gap-0.5 p-0 text-sm" data-result aria-label="Draft lines">
      {lines.map((l) => {
        const box = comments.state.boxes[l.n];
        return (
          <li key={l.n} className="group" data-line={l.n}>
            <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_1.75rem] items-start gap-2 px-2">
              <span aria-hidden="true" className="select-none pt-0.5 text-right text-xs tabular-nums text-muted-foreground">{l.n}</span>
              <span className="min-h-5 whitespace-pre-wrap [overflow-wrap:anywhere]">{l.text}</span>
              {l.commentable ? (
                <button
                  type="button" id={buttonId(l.n)} aria-label={`Comment on line ${l.n}`} aria-expanded={!!box} disabled={!!block} title={block ?? undefined}
                  onClick={() => comments.onOpen(l.n, l.text)}
                  className={cn(
                    'grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
                    'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
                    box && 'opacity-100',
                  )}
                ><MessageSquarePlus aria-hidden="true" className="size-4" /></button>
              ) : <span />}
            </div>
            <SentNotes notes={comments.state.sent[l.n] ?? []} now={now} />
            {box && <CommentForm line={l.n} box={box} lines={lines} block={block} buttonId={buttonId(l.n)} comments={comments} />}
          </li>
        );
      })}
      {extra.map((n) => (
        <li key={n} data-line={n}>
          <CommentForm line={n} box={comments.state.boxes[n]!} lines={lines} block={block} buttonId={buttonId(n)} comments={comments} />
        </li>
      ))}
    </ol>
  );
}
