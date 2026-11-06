/** "1 task" / "3 tasks" — a count with its noun, pluralised by a trailing "s". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
