---
name: debugging
description: Systematic root-cause debugging methodology for any bug, test failure, crash, or unexpected behavior, in any language or framework. Use this before proposing a fix whenever something is broken — a failing test, a stack trace, a wrong output, an intermittent/flaky failure, or a "this used to work" regression. Especially important under time pressure or after a first fix attempt didn't stick, since that's exactly when guessing feels tempting but costs the most.
---

# Debugging

## Core principle

Find the root cause before changing any code. A fix that makes the symptom go away without you understanding why it was happening is not a fix — it's a delay until the bug resurfaces somewhere else.

The reason this matters more than it seems: the first thing you try tends to set the pattern for everything after it. If you start by guessing, you end up guessing three more times, each guess narrower and more frustrated than the last. If you start by understanding, the fix that falls out is usually obvious and small.

## When to slow down and actually do this

Every bug, test failure, or "unexpected behavior" report. It's tempting to skip the process for the ones that feel simple, or the ones that are urgent — but simple-looking bugs still have real causes, and systematic investigation is faster than thrashing even under a deadline, because thrashing produces fixes that don't hold.

Treat these as signals to restart from the top, not to push through with another patch:
- You've already tried a fix and it didn't work
- You're about to try something because it "might work," without being able to say why
- Each attempted fix reveals a new, different-looking problem somewhere else
- You're tempted to change several things at once "while you're in there"

## The four phases

Work through these in order. Don't jump to phase 4 because the fix "seems obvious" — that instinct is exactly what phase 1 exists to check.

### Phase 1 — Understand what's actually happening

1. **Read the whole error, not just the first line.** Stack traces, exit codes, and warning text usually name the file, line, and condition involved — skimming past them is the single most common way to waste time on a bug.
2. **Reproduce it on demand.** If you can't trigger it reliably yet, that's the task — gather more data (repeat runs, vary inputs, check for timing/order dependence) rather than guessing at a fix for something you can't yet confirm you've fixed.
3. **Check what changed.** `git log`/`git diff` around when the behavior started, new dependencies, config or environment differences. Bugs introduced today are usually explained by something that changed today.
4. **For a bug that crosses component boundaries** (client → API → service → database, or build → sign → deploy), don't guess which layer is at fault — add a log or assertion at each boundary showing what data entered and left it, run once, and read the evidence to see exactly where it diverges from what you expect.
5. **For a bug deep in a call stack**, trace backward from the point of failure rather than fixing where the error surfaced. See `references/root-cause-tracing.md`.

### Phase 2 — Find the pattern

1. Look for similar code in the same codebase that already works correctly.
2. Diff the broken case against the working one, line by line. List every difference you find, even ones that seem like they "can't matter" — that instinct is often wrong, and it's cheap to check.
3. If you're implementing or matching an existing pattern, read the reference implementation in full before adapting it. A half-read pattern produces a half-correct copy.

### Phase 3 — Form and test one hypothesis at a time

1. State the hypothesis explicitly: "I think X is the cause because Y." Vague hunches don't tell you what would prove them wrong.
2. Make the smallest possible change that tests it — one variable, not a bundle of plausible-looking edits.
3. If it doesn't confirm the hypothesis, don't layer another fix on top. Form a new hypothesis from what you just learned and go again.
4. If you genuinely don't know, say so rather than shipping a guess dressed up as a fix.

### Phase 4 — Fix at the source and verify

1. Write a failing test that reproduces the bug before touching the fix, so you have a real check for "actually resolved" rather than "looks resolved."
2. Make one change addressing the root cause you identified — no incidental refactoring or "while I'm here" cleanup bundled in.
3. Confirm the new test passes and nothing else broke.
4. Once the root cause is confirmed, consider whether the same bad data could reach this code path through another route, and validate at each layer it passes through rather than only where you happened to find it. See `references/defense-in-depth.md`.

**If a fix doesn't hold:** go back to Phase 1 with what you just learned — don't try attempt after attempt. After three failed attempts, stop trying fixes altogether. That pattern — each fix revealing a new problem somewhere else, or needing progressively larger changes — usually means the underlying design is the actual problem, not the code you've been editing. That's worth surfacing and discussing before attempt four, not after.

## A note on flaky or timing-dependent failures

If a bug only reproduces sometimes, resist the urge to paper over it with a longer sleep or retry loop before you've applied Phase 1 — "sometimes" almost always means there's a real race or ordering dependency to find. Once you've found it, `references/condition-based-waiting.md` covers replacing arbitrary waits with waiting on the actual condition, which is usually also the fix.

## Rationalizations worth noticing in yourself

| What you might think | Why it doesn't hold up |
|---|---|
| "It's simple, I don't need the full process" | Simple bugs have causes too — the process is quick when the bug really is simple. |
| "No time, just patch it" | An unverified guess under pressure is usually the slowest path, because it doesn't hold. |
| "Let me try this first, then investigate properly" | Whatever you try first sets the pattern — start with understanding. |
| "I'll write the test after confirming the fix works" | Without a test written first, "confirming" is just looking at it and hoping. |
| "I'll change a few things and rerun" | If it passes, you won't know which change mattered — and you can't undo just the wrong one. |
| "I see what's wrong, let me just fix it" | Seeing a symptom isn't the same as knowing why it happens. |
| "One more attempt" (after two failed already) | Three failures is a signal about the design, not a reason to try a fourth patch. |

## Reference files

- `references/root-cause-tracing.md` — walking a bug backward through the call stack to its origin, instead of patching where it surfaces
- `references/defense-in-depth.md` — once a root cause is confirmed, validating the same bad data at every layer it can reach, not just the one you found it in
- `references/condition-based-waiting.md` — replacing arbitrary timeouts/sleeps with waiting on the real condition, for flaky or timing-dependent bugs
