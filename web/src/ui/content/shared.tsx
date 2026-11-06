import { AtSign, Briefcase, Download, FileText, MessagesSquare, X } from 'lucide-react';
import type { ComponentType } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { PLATFORM_LABELS } from '../../lib/contentRules';
import type { AssetState, Platform, PostStatus } from '../../lib/contentRules';
import type { PostDto } from '../../lib/contentTypes';
import { ASSET_STATE_DOT, assetStateLabel, formatLabel, STATUS_LABELS, STATUS_TONE } from '../../lib/contentView';
import { RelativeTime } from '../design/RelativeTime';

const ICONS: Record<Platform, ComponentType<{ className?: string }>> = { linkedin: Briefcase, instagram: AtSign, x: X, facebook: MessagesSquare, blog: FileText };

/** The icon of a platform, named for screen readers. */
export function PlatformIcon({ platform, className = 'size-3.5' }: { platform: Platform; className?: string }) {
  const Icon = ICONS[platform];
  return <span title={PLATFORM_LABELS[platform]} role="img" aria-label={PLATFORM_LABELS[platform]} className="inline-flex"><Icon className={className} /></span>;
}

/** An asset's state as a dot and a word; the wire value `empty` reads "Not started". */
export function AssetStateLabel({ state }: { state: AssetState }) {
  return <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><span aria-hidden className={cn('size-2 rounded-full', ASSET_STATE_DOT[state])} />{assetStateLabel(state)}</span>;
}

/** Icon and text, so being imported never rests on colour alone. */
export function ImportedBadge() {
  return <Badge variant="info" className="shrink-0"><Download aria-hidden="true" className="size-3" />Imported</Badge>;
}

export function StatusChip({ status }: { status: PostStatus }) {
  return <span data-status={status} className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_TONE[status])}>{STATUS_LABELS[status]}</span>;
}

/** One post as a chip: platform icon, format, date and status colour. */
export function PostChip({ post, timeZone, now }: { post: PostDto; timeZone: string; now?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs">
      <PlatformIcon platform={post.platform} />
      <span>{formatLabel(post.format)}</span>
      <span className="text-muted-foreground"><RelativeTime at={post.scheduledAt} timeZone={timeZone} now={now} /></span>
      <StatusChip status={post.status} />
    </span>
  );
}
