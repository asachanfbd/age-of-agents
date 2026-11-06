# Sky, celestial lighting and water

The scene uses SunCalc 1.9 to calculate sun/moon altitude and azimuth, lunar illuminated fraction, bright-limb angle, and distance from the current UTC instant. New Delhi (28.6139 N, 77.2090 E) is the default observation site in `web/src/scene/celestial.ts`. The UI clock remains IST. Calculations are local; no location permission or external API is needed.

East is screen-right, west screen-left, north away from the viewer, and south toward the viewer. World light bearings follow the visible panorama: its sources sit north of town, with east/west offsets matching the discs. Astronomical elevation controls shadow length. The visible sky is a stylized panoramic projection above a fixed horizon, compressing altitude to fit the town camera; it is not a literal north-facing astronomical view. Discs are enlarged for readability, with lunar diameter varying in proportion to inverse distance. Lunar phase is rendered with a curved terminator, oriented using the bright-limb and parallactic angles.

The closer town framing retains the surrounding mountain ridges, with a narrow northern inlet. Stars and celestial discs use depth testing, so land, trees and buildings occlude them. The ocean is a continuous world-space surface over intact terrain; depth testing forms the shoreline. There is no screen-space ocean cutoff or discarded seabed. Distance fog softens the water toward the actual horizon, which can lie above the viewport when looking down at town. Reflections are stylized animated streaks drawn only by the ocean material, aligned horizontally beneath each disc. Moonlight and its reflection depend on phase, altitude and darkness; sunset/sunrise reflections fade as the sun climbs. The town ponds retain their standard water material.

Run `npm test --prefix web` and `npm run build --prefix web`. For visual QA in development, append `?sceneTime=2026-09-26T18%3A30%3A00Z` (full-moon night) or `?sceneTime=2026-09-14T12%3A45%3A00Z` (sunset). This freezes only the scene time, not the UI clock. Production ignores this parameter. Remove the query to return to live time.

Reference: https://github.com/mourner/suncalc/tree/v1.9.0
