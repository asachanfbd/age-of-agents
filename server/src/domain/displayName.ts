/**
 * How a user-facing message (an error the UI shows) refers to a record: by its human name —
 * `task "Fix login"`, `project "Shop"` — or, when that name isn't known, generically (`this task`).
 * Never by id: ids mean nothing to a person and belong only in server logs.
 * tests/errorMessages.test.ts guards this.
 */
export function named(kind: string, name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? `${kind} "${trimmed}"` : `this ${kind}`;
}

/** `named` at the start of a sentence: `Task "Fix login" …` / `This task …`. */
export function namedAtStart(kind: string, name?: string | null): string {
  const text = named(kind, name);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
