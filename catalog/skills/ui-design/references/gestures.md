# Gestures

## Direct manipulation

- Respond on pointer-down.
- Track 1:1 with the pointer, using Pointer Events with pointer capture, and keep the grab offset.
- Never lock input during a transition. Animate from the live on-screen value so motion can always be interrupted.
- Once a drag has started, ignore extra touch points.

## Springs

Use springs, not CSS keyframes, for gesture-driven motion.

- Default: damping 1.0 (no overshoot), response 0.3–0.4s.
- After a flick or throw: damping about 0.8.
- In Motion: `bounce: 0` by default, about `0.2` after momentum.

## Release

- Hand off the release velocity to the spring.
- Project the landing point with `current + (v/1000)·d/(1−d)`, where d ≈ 0.998, then snap to the nearest target.
- Use the sign of the velocity to decide reverse versus commit.
- Dismiss on velocity, not only on distance.

## Boundaries

Past a boundary, rubber-band with progressive resistance. Never a hard stop.
