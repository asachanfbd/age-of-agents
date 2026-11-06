import type { ComponentProps, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

type CopyButtonProps = Omit<ComponentProps<typeof Button>, 'onClick' | 'children'> & {
  text: string;
  /** Accessible name, e.g. "Copy file". */
  label: string;
  /** Visible text beside the icon; omit for an icon-only button. */
  children?: ReactNode;
  onError?: () => void;
};

const COPIED_FEEDBACK_MS = 1500;

/** Copies `text` to the clipboard, swapping its icon for a check for a moment to confirm. */
export function CopyButton({ text, label, children, onError, variant = 'ghost', size = 'icon-sm', ...props }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      onError?.();
    }
  }

  return (
    <Button type="button" variant={variant} size={size} onClick={() => void copy()} aria-label={label} title={copied ? 'Copied' : label} {...props}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {children && (copied ? 'Copied' : children)}
    </Button>
  );
}
