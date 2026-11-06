import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bot, User } from 'lucide-react';

/** User vs. agent avatar for a `ChatBubble` — purely visual, distinguishes the two speakers at a glance. */
export function ChatAvatar({ role }: { role: 'user' | 'agent' }) {
  return (
    <Avatar className="size-7 shrink-0">
      <AvatarFallback
        className={role === 'user' ? 'bg-secondary text-secondary-foreground' : 'bg-primary/15 text-primary'}
      >
        {role === 'user' ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </AvatarFallback>
    </Avatar>
  );
}
