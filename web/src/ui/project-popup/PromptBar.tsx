import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ArrowUp, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAutoResizeTextarea } from '../chat/useAutoResizeTextarea';

/**
 * The AI prompt shared by the Plan and Task dialogs
 * (creates an open task): a growing textarea, with the send button beside it. Callers own the
 * message and any agent choice (shown by the shared coding-agent picker above the bar); this owns
 * Enter-to-send and the pending/error state of a send.
 * `onSend` throws to report a failure, which is shown below the prompt.
 */
export function PromptBar({
  message,
  onMessageChange,
  onSend,
  unavailable = false,
  placeholder,
  ariaLabel,
  hint,
  autoFocus,
  sendLabel = 'Send',
}: {
  message: string;
  onMessageChange: (next: string) => void;
  onSend: (trimmed: string) => Promise<void>;
  /** True when nothing could run a send right now, which disables the prompt. */
  unavailable?: boolean;
  placeholder: string;
  ariaLabel: string;
  hint: string;
  autoFocus?: boolean;
  /** Names the submit button. Anything but "Send" is shown as a text button, since the arrow alone would not say what it does. */
  sendLabel?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const textareaRef = useAutoResizeTextarea(message, 160);
  const canCompose = !pending && !unavailable;
  const trimmed = message.trim();

  async function submit() {
    if (!trimmed || !canCompose) return;
    setPending(true);
    setError('');
    try {
      await onSend(trimmed);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="rounded-2xl border bg-card shadow-xs transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <textarea
          ref={textareaRef}
          rows={1}
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={!canCompose && !pending}
          autoFocus={autoFocus}
          className="block max-h-40 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="flex items-center justify-between p-2">
          <Button type="button" variant="ghost" size="icon-sm" className="rounded-lg" aria-label="Attach file — coming soon" title="Attachments are coming soon" disabled>
            <Plus aria-hidden="true" />
          </Button>
          <div className="flex items-center gap-1">
            {sendLabel === 'Send' ? (
              <Button type="submit" size="icon-sm" className="rounded-lg" aria-label="Send" disabled={!trimmed || !canCompose}>
                <ArrowUp aria-hidden="true" />
              </Button>
            ) : (
              <Button type="submit" size="sm" className="rounded-lg" disabled={!trimmed || !canCompose}>{sendLabel}</Button>
            )}
          </div>
        </div>
      </form>
      {error && <p role="alert" className="mt-2 text-center text-sm font-medium text-destructive">{error}</p>}
      <p className="mt-2 text-center text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
