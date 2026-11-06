import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui's standard class-merging helper — combines conditional classNames (clsx) and
 * resolves conflicting Tailwind utility classes (tailwind-merge). Every component under
 * `components/ui/` imports this via the `@/lib/utils` alias. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
