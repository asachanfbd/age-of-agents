# Defense-in-depth validation

A single validation check feels like it closes a bug out. But it only closes the one path you tested — a different caller, a mock, a refactor, or an edge case on another platform can walk right past it. The stronger fix makes the bad state impossible no matter which path reaches it, by checking at every layer the data passes through on its way to causing damage.

## The layers, in the order data usually crosses them

1. **Entry validation** — reject obviously invalid input where it first enters the system (empty/missing required fields, wrong type, path that doesn't exist).
2. **Business-logic validation** — check that the value makes sense for *this specific operation*, even if it passed entry validation upstream (a valid directory path that nonetheless isn't the right kind of directory for this call).
3. **Environment/context guards** — block dangerous operations in contexts where they should never happen at all (e.g., refuse to run a destructive filesystem operation outside a known-safe temp directory while tests are running).
4. **Diagnostic instrumentation** — when the first three layers can't fully prevent an edge case, at least log enough context (value, call stack, surrounding state) right before the risky operation so the next occurrence is traceable instead of mysterious.

## Why more than one layer

Each layer catches a different way of getting the bad value there:
- A new call site bypasses layer 1 if it constructs its request differently than the one you first debugged.
- A mock or test double bypasses layer 2 by never going through the real business logic at all.
- A different platform or environment can hit an edge case that only layer 3 was written to guard against.
- Layer 4 doesn't prevent anything, but it means the *next* gap is a five-minute diagnosis instead of another multi-hour trace.

## Applying it

After `root-cause-tracing.md` gets you to the origin of a bug:

1. Map every point the bad value passes through between its origin and where it caused the failure.
2. Add a check at each one — don't stop after the first check succeeds in your manual test.
3. Deliberately try to reach the bug through a different path than the one you originally found (a different caller, a different test) to confirm the later layers actually catch it too.

One validation point proves you fixed the case you saw. Validation at every layer is what makes the bug structurally unable to recur.
