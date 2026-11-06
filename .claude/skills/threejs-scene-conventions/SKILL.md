---
name: threejs-scene-conventions
description: Three.js / React Three Fiber scene conventions for agent-visual-os — camera and controls, the drag-and-raycast pattern, lighting, status colors, and Html labels/popups. Use when building or changing anything under web/src/scene/, or implementing visual effects like the day-night/dusk-dawn cycle.
---

# Three.js scene conventions

Non-obvious conventions for agent-visual-os's `web/src/scene/` — a fresh read of Three.js/R3F docs won't tell you these; they're decisions specific to this scene.

## Camera and controls: clamped pan, zoom and rotate

`Scene.tsx` mounts drei's `MapControls` (left-drag pans on the ground plane, wheel/pinch/middle zooms, right-drag or Shift+left-drag rotates and tilts) with distance and polar limits from `cameraMath.ts`. The limits the controls cannot express (target kept inside `MAP_HALF`, the street-walk curve that lowers elevation toward 28° as you zoom in, NaN fallbacks) are applied by `cameraController.ts` on every controls `change`. `enabled={controlsEnabled}` pauses all camera input, Home and the minimap while a Project is dragged. Two non-obvious rules:
- OrbitControls aims the camera *before* it dispatches `change`, so any write to the camera inside a `change` handler must re-aim with `object.lookAt(target)` and must not call `update()` (that applies damping twice). Pinned by I13 in `web/tests/cameraController.test.mjs`.
- Camera state (orbit, flights, minimap footprint) lives in the controller, never in `worldStore`, so moving the camera does not re-render the scene or yards. The Home view is `DEFAULT_VIEW` (`defaultView.ts`) and nothing else; `HOME_ORBIT` is derived from it. Pure rules go in `cameraMath.ts`/`minimapMath.ts` so node tests can import them without three.js.

## Dragging a building

Buildings are dragged by raycasting the pointer's world-space ray against the ground plane (`y = 0`) directly — `t = -ray.origin.y / ray.direction.y`, then `origin + direction * t` — rather than three's `Raycaster`/`Plane` helpers; it's cheaper and avoids allocating extra objects per frame. `setPointerCapture` on pointer-down keeps the mesh receiving move/up events even once the cursor leaves its bounds.

**The gotcha**: R3F fires `onPointerMove` on a mesh for plain hover, not only while a button is held. Every drag handler gates on an explicit ref (e.g. `isDraggingRef`, set `true` on pointer-down and `false` on pointer-up) and bails immediately if it's not set — without that gate, hovering alone drags the object. See `ProjectYard.tsx` (`isDraggingRef`, and its 4 px threshold that tells a click on a yard item from a drag of the yard).

## Status color palette

Two colors carry every "is this working or idle" signal in the scene: idle is blue-gray (`#5b6b8c`), developing/active is amber (`#c98a3c`, glow accent `#ffb35c`). They're reused across a building's body color/emissive and its spinning ring; the building's indicator sphere is the sole status signal now — the worker model (see below) ships its own fixed materials and isn't recolored by status. Keep any new status visualization on this same palette rather than inventing an unrelated one — the point is that idle/active reads the same way everywhere in the scene.

## Html labels and popups

Building name tags and the details popup both use drei's `<Html>` without a `transform` prop — that renders a normal, camera-facing DOM element at a constant pixel size regardless of distance (no perspective scaling), which is what a label needs. `occlude={false}` keeps them visible even when a mesh sits between them and the camera; deliberate for a scene this small and uncluttered.

## Robots and yard items are procedural, shared-geometry meshes

The robot, crate, machine, merge pin and planning station are built from primitive meshes in `yardParts.tsx` (`Robot`, `Crate`, `Machine`, `MergePin`, `PlanningStation`). Their geometries and materials are created once at module scope and shared by every instance, so many Projects cost draw calls, not allocations; never build a `new THREE.*Geometry` per instance. A robot's poses (working, waiting, holding a box, seated at a laptop) are limb angles driven by its `pose` prop and `motion` ref, not animation clips.

Movement is a closed-form walk inside `useFrame`, not physics or pathfinding: `yardMotion.ts`'s `advanceWalker` moves a robot along a queue of yard points (and runs queued actions such as "both disappear"). The paths themselves are pure functions in `web/src/lib/villageLayout.ts` (`pathFromDoor`, slot and lane positions), tested in `web/tests/villageLayout.test.mjs`; a new path must keep out of the dome footprint and away from other robots' slots. How an entity got where it is (walk-out, carry-in, carry to merge, fade in, appear in place) comes from `lib/villageYard.ts`'s `yardTransitions`; `YardEntities.tsx` only acts on it.

## The canvas renders on demand, not every frame

`<Canvas frameloop="demand">` (`web/src/ui/WorldView.tsx`) draws a frame only when something asks for one. That's what keeps the GPU near idle while every project is idle. Changed props on three objects, drei's `MapControls` (including its damping) and `invalidate()` calls all request frames. A mutation made inside `useFrame` through a ref does not. So anything that animates continuously must call `state.invalidate()` from its own `useFrame` while it moves, and should stop when it's done. Also skip the call while a popup covers the scene (`isSceneCovered` in `web/src/lib/sceneRendering.ts`). `YardEntities.tsx`'s `useWalker` and `usePresence` are the reference. Slow drift like the sun, moon and sky colours isn't animated per frame. `Scene.tsx` repaints it every `SKY_REFRESH_MS` (3 minutes) and whenever another frame happens to render anyway. A new effect that animates without requesting frames will look frozen. One that requests frames forever brings back the constant GPU load. `web/tests/sceneRendering.test.mjs` pins the wiring.

## Implementing day/night/dusk/dawn (not yet built)

Drive every light and color off one shared `timeOfDay` value (0–1, or a running clock) instead of animating each light independently:

- Define a small set of keyframe colors (night / dawn / day / dusk) for the `hemisphereLight`'s sky and ground colors, the `directionalLight`'s color and intensity, and the `fog` color.
- Interpolate between keyframes with `THREE.Color.lerpColors`, keyed by `timeOfDay`.
- Advance `timeOfDay` in a `useFrame` (or a slower store-driven tick), and consider a toggle to freeze it — the rest of this scene is deliberately static/simple, so an always-running cycle should be opt-in, not forced on.
- `timeOfDay` is visual-only state: it belongs in `worldStore.ts` (coordinate the field name/shape with ui-interaction-engineer since the store is shared), not in a separate store.

## On importing external Three.js reference

General Three.js/vanilla-API tutorials and skill packs (raycasting basics, light types, shader fundamentals) mostly restate what a model already knows — reach for them only for genuinely unfamiliar techniques (a specific postprocessing effect, a shader trick), and translate imperative examples (`addEventListener`, manual `Raycaster`) into this codebase's declarative R3F idiom rather than copying them in verbatim.
