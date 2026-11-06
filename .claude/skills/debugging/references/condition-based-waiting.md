# Condition-based waiting

Flaky, timing-dependent failures are usually the result of guessing how long an async operation takes rather than waiting for it to actually finish. A fixed delay passes on a fast machine and fails under load or in CI — the delay was never the real dependency, the *completion of the operation* was.

## The fix

Replace a guessed delay with a poll on the actual condition you care about:

```
// Guessing at timing — flaky under load
sleep(50)
result = getResult()
assert result is not None

// Waiting for the real condition — reliable regardless of speed
waitFor(() => getResult() is not None)
result = getResult()
assert result is not None
```

A minimal `waitFor` polls the condition on an interval with a timeout, and raises a clear error naming what it was waiting for if the timeout is hit:

```
function waitFor(condition, description, timeoutMs = 5000):
    start = now()
    while true:
        value = condition()
        if value: return value
        if now() - start > timeoutMs:
            raise Error(f"Timeout waiting for {description}")
        sleep(10)  # poll interval — short enough not to add real delay
```

## Common patterns

| Waiting for | Condition |
|---|---|
| An event to fire | `events.find(e => e.type == 'DONE')` |
| A state transition | `machine.state == 'ready'` |
| A collection to fill | `items.length >= expectedCount` |
| A file to appear | `fileExists(path)` |

## Mistakes to avoid

- **Polling too fast** (every 1ms) wastes CPU for no real benefit — 10ms is plenty for most cases.
- **No timeout** turns a bug into a hang. Always bound the wait and fail loudly with a description of what didn't happen.
- **Caching the value outside the loop** — call the actual getter/condition fresh on every iteration, or you'll wait on stale data forever.

## When a fixed delay is still correct

Only when you're testing actual timing behavior itself (a debounce interval, a throttle window) — and even then, wait for the triggering condition first, then apply a delay whose length is justified by a known interval, with a comment explaining why:

```
waitFor(() => tool.status == 'STARTED')   // wait for the real trigger first
sleep(200)                                 // then: 2 ticks at a known 100ms interval
```

If you can't point to a specific reason a delay's length is correct, it's a guess — replace it with `waitFor`.
