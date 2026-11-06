import { AtSign, Briefcase, Link, Mail, MessagesSquare, Phone } from 'lucide-react';
import type { ComponentType } from 'react';
import type { ChannelType } from '../../lib/crmTypes';

const ICONS: Record<ChannelType, ComponentType<{ className?: string }>> = { email: Mail, phone: Phone, instagram: AtSign, facebook: MessagesSquare, linkedin: Briefcase, other: Link };

/** The icon of a channel type, named for screen readers. */
export function ChannelIcon({ type, className = 'size-3.5' }: { type: ChannelType; className?: string }) {
  const Icon = ICONS[type];
  return <span title={type} role="img" aria-label={type} className="inline-flex"><Icon className={className} /></span>;
}
