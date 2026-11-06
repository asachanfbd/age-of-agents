/** One or two capital letters for an avatar: the first letters of the first and last word; "?" when there is nothing to show. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]!][0]!;
  const last = words.length > 1 ? [...words[words.length - 1]!][0]! : '';
  return (first + last).toUpperCase();
}

/** The avatars to draw and how many more there are. */
export function avatarOverflow<T>(items: readonly T[], max: number): { shown: T[]; more: number } {
  const limit = Math.max(0, Math.floor(max));
  return { shown: items.slice(0, limit), more: Math.max(0, items.length - limit) };
}
