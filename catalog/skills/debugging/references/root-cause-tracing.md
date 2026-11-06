# Root-cause tracing

Bugs often surface far from where they actually start — a wrong value crashes deep in a call stack, but the code at the crash site is only the messenger. Fixing the crash site treats the symptom; the same bad value will find another way to cause trouble later.

## The process

1. **Name the immediate cause.** What line of code directly produced the failure?
2. **Ask what called it, with what value.** Walk one frame up the stack. Was the value already wrong when it arrived here?
3. **Keep walking up** until you reach the point where the bad value was first created or first went wrong — not just where it was first *used* badly.
4. **Fix at that origin point**, not at any of the intermediate frames.

### Worked example

- Symptom: a `git init` runs inside the source tree instead of a temp directory.
- Immediate cause: `execFileAsync('git', ['init'], { cwd: projectDir })` — but `projectDir` was empty, and an empty `cwd` resolves to the process's own working directory.
- One level up: `projectDir` was passed in empty from a workspace-setup call.
- One level further: that call received an empty string from test setup.
- Origin: a test fixture returned `{ tempDir: '' }` before its `beforeEach` had actually run, and the test code read `tempDir` too early.
- Fix: make the fixture's `tempDir` a getter that throws if accessed before setup completes — the empty value becomes structurally impossible instead of just unlikely.

## When you can't trace by reading alone

Add a log line immediately *before* the risky operation, capturing the value in question, the current working state, and a stack trace (`new Error().stack` works in most languages/runtimes that support it) — then run once and read the trace to see exactly which call path produced the bad value.

If the bug depends on which order things run in (e.g., stray state from one test leaking into another), bisect: run subsets of the suite/sequence, narrowing until a single item is left that reproduces it in isolation.

## The rule this enforces

Never fix only where the error appeared. If you can trace one level further up, do it — the actual fix belongs at the origin, and everywhere in between is a candidate for the validation described in `defense-in-depth.md`.
