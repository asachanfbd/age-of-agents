import assert from 'node:assert/strict';
import { readdir, readFile, access } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Source-wiring checks for the 3D village's dome + yard scene. There is no DOM or WebGL harness in
// this repo (.docs/testing.md), so these pin how the components are put together; what the scene
// looks like is a manual browser check.
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const exists = (path) => access(new URL(path, import.meta.url)).then(() => true, () => false);

const scene = await read('../src/scene/Scene.tsx');
const yardFile = await read('../src/scene/ProjectYard.tsx');
const entities = await read('../src/scene/YardEntities.tsx');
const parts = await read('../src/scene/yardParts.tsx');
const worldView = await read('../src/ui/WorldView.tsx');
const overlay = await read('../src/ui/VillageOverlay.tsx');
const css = await read('../src/index.css');
const app = await read('../src/App.tsx');
const topBar = await read('../src/ui/TopBar.tsx');
const cards = await read('../src/ui/ProjectCardsView.tsx');
const home = await read('../src/scene/HomeBuilding.tsx');
const logPopup = await read('../src/ui/project-popup/commands/CommandLogPopup.tsx');
const testing = await read('../src/ui/project-popup/TestingPanel.tsx');
const yardHook = await read('../src/lib/useYardModel.ts');
const tasksPanel = await read('../src/ui/project-popup/TasksPanel.tsx');
const store = await read('../src/store/worldStore.ts');

async function sourceFiles(dir) {
  const entries = await readdir(new URL(dir, import.meta.url), { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile() && /\.(tsx?|css|mjs)$/.test(e.name)).map((e) => `${e.parentPath ?? e.path}/${e.name}`);
}

test('C01 the Scene draws one warehouse + yard per Project and no tower or robot ring', () => {
  assert.match(scene, /projects\.map\(\(project\) => \(\s*<ProjectYard key=\{project\.id\} project=\{project\} \/>/);
  assert.doesNotMatch(scene, /ProjectBuilding|ProjectWorkers|<Worker\b/);
  assert.match(yardFile, /<Warehouse color=\{tint\} statusColor=\{statusStyle\.dotColor\} glowing=\{statusStyle\.glowing\} selected=\{selected\} \/>/);
  assert.doesNotMatch(yardFile + parts, /\bDome\b|G\.dome|domeMaterials/);
  assert.doesNotMatch(yardFile + parts, /BODY_GEOMETRY|FACADE|createWindowTexture/);
});

test('C02 geometries and materials are module-scope and shared; nothing builds a geometry per instance', () => {
  const componentBodies = parts.slice(parts.indexOf('export function YardGround'));
  assert.doesNotMatch(componentBodies.replace(/function paintYard[\s\S]*?\n}\n/, ''), /new THREE\.\w+Geometry\(/);
  assert.doesNotMatch(entities + yardFile, /new THREE\.\w+(Geometry|Material)\(/);
  assert.match(parts, /^const G = \{/m);
  assert.match(parts, /^const M = \{/m);
  assert.match(parts, /const roofCache = new Map/, 'one roof material per Building Type colour');
});

test('C03 the warehouse label reuses the status dot, progress bar and building-label classes, with the buildingBadge wording', () => {
  assert.match(yardFile, /<ProjectStatusDot style=\{statusStyle\} label=\{dotLabel\} \/>/);
  assert.match(yardFile, /\{progress && <TaskProgressBar progress=\{progress\} className="building-progress h-\[6px\] w-\[70%\] self-center" \/>\}/);
  assert.match(yardFile, /const badge = buildingBadge\(project\);/);
  assert.match(yardFile, /\{badge && <span className="building-type-badge">\{badge\}<\/span>\}/);
  assert.match(yardFile, /useProjectIndicators\(project\)/, 'no bar until the plan loads: the shared indicators return null progress');
});

test('C04 the cards view and the shared dot and bar are untouched', async () => {
  assert.doesNotMatch(cards, /building-type-badge|yard-tag|villageYard/);
  assert.match(await read('../src/ui/TaskProgressBar.tsx'), /'flex h-1\.5 w-full gap-px overflow-hidden rounded-full bg-muted-foreground\/25'/);
});

test('C05 the new tag, label and strip styles loop no animation', () => {
  const yardCss = css.slice(css.indexOf('.building-type-badge'), css.indexOf('.markdown-document'));
  assert.ok(yardCss.includes('.yard-tag'));
  assert.doesNotMatch(yardCss, /animation(-name)?\s*:/);
  assert.doesNotMatch(overlay, /animate-/);
});

test('C06 animation asks for frames only while something moves and nothing covers the scene', async () => {
  for (const source of [entities, parts]) assert.match(source, /if \([^)]*!covered\) state\.invalidate\(\)/);
  assert.match(parts, /const animating = moving \|\| pose === 'work' \|\| pose === 'wait' \|\| settle\.current > 0;\s*if \(animating && !covered\) state\.invalidate\(\);/, 'a holding, idle or seated robot settles into a still pose');
  assert.match(entities, /const pose: RobotPose = !robotShown \? 'idle'/, 'the robot inside the warehouse behind a red box is still');
  assert.match(parts, /if \(failed\) return;/, 'a red machine is still');
  assert.match(entities, /if \(moving && !covered\) state\.invalidate\(\);/);
  assert.match(await read('../src/ui/WorldView.tsx'), /frameloop="demand"/);
});

test('C07 the scene still loads lazily; the cards view and top bar import no scene component', () => {
  assert.match(app, /lazy\(\(\) => import\('\.\/ui\/WorldView'\)\)/);
  assert.doesNotMatch(app, /from '\.\/scene\/|VillageOverlay/);
  assert.doesNotMatch(cards, /\.\.\/scene\/|@react-three/);
  assert.doesNotMatch(topBar, /scene\/(?!townLayout)/, 'the top bar reads only the plain plot list');
});

test('C08 a yard drag uses the 4px threshold, moves on release and disables the controls; a click opens what was hit', () => {
  assert.match(yardFile, /const DRAG_START_THRESHOLD_PX = 4;/);
  assert.match(yardFile, /setControlsEnabled\(false\)/);
  assert.match(yardFile, /setControlsEnabled\(true\)/);
  assert.match(yardFile, /moveProject\(project\.id, point\[0\], point\[1\]\)/);
  assert.match(yardFile, /e\.stopPropagation\(\);/);
  assert.match(yardFile, /else if \(isYardClick\(pressStarted, false\)\)/);
  assert.match(yardFile, /const target = yardTargetOf\(e\.object\);/);
  assert.match(yardFile, /if \(target\) openTarget\(target\);/);
  assert.doesNotMatch(yardFile, /\btargetOf\(/, 'the old dome-fallback helper is gone');
  assert.match(yardFile, /openYardTarget\(project\.id, target, state, \{/);
  assert.match(entities, /userData=\{\{ yardTarget: target \}\}/);
});

test('C09 clicks route through openYardTarget to the store actions', () => {
  assert.match(yardFile, /openCommandRunFromVillage: \(projectId, runId\) => void state\.openCommandRunFromVillage\(projectId, runId\)/);
  assert.match(yardFile, /openTestRunFromFooter: \(projectId, runId\) => void state\.openTestRunFromFooter\(projectId, runId\)/);
  assert.match(entities, /yardTarget: \{ kind: 'more' \}/);
});

test('C10 tags sit below the details popup; work tags always show; merge, planning and marker details only on hover; tags scale with distance', () => {
  assert.match(entities, /zIndexRange=\{SCENE_HTML_Z_RANGE\}/);
  assert.match(entities, /distanceFactor=\{TAG_DISTANCE_FACTOR\}/);
  assert.match(entities, /const tagVisible = !leaving && \(area === 'work' \|\| hovered\);/);
  assert.match(entities, /visible=\{hovered && !leaving\}/, 'planning');
  assert.match(entities, /\{hovered && <div className="yard-tag__line">\{details\}<\/div>\}/, '"+N more" details');
  assert.match(yardFile, /zIndexRange=\{SCENE_HTML_Z_RANGE\}/);
});

test('C11 City Center is unchanged and still opens the Catalog', () => {
  assert.match(home, /onPointerDown=\{\(e\) => \{ e\.stopPropagation\(\); openCatalog\(\); \}\}/);
  assert.match(home, /City Center<\/span>/);
  assert.match(scene, /<HomeBuilding \/>/);
});

test('C12 the old tower, robot ring and their helpers are gone with no references left', async () => {
  for (const file of ['../src/scene/ProjectBuilding.tsx', '../src/scene/ProjectWorkers.tsx', '../src/scene/Worker.tsx', '../src/scene/workerRoute.ts', '../src/scene/lot.tsx',
    '../src/scene/buildingTint.ts', '../src/lib/useProjectRobotTasks.ts', './robotAssignment.test.mjs']) {
    assert.equal(await exists(file), false, file);
  }
  const offenders = [];
  for (const file of [...await sourceFiles('../src/'), ...await sourceFiles('./')]) {
    if (file.endsWith('villageScene.test.mjs')) continue;
    const source = await readFile(file, 'utf8');
    if (/selectRobotTaskRows|MAX_ROBOTS_PER_BUILDING|PROJECT_ROOF_TOP|plotAccess|robotSpots|workerRoute|useProjectRobotTasks|ROBOT_SCALE|ProjectWorkers|ProjectBuilding\b/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('C12b the robot is the animated RobotExpressive model, cloned per robot and driven by clips', async () => {
  assert.equal(await exists('../public/models/RobotExpressive.glb'), true);
  assert.match(parts, /MODEL_PATH = '\/models\/RobotExpressive\.glb'/);
  assert.match(parts, /SkeletonUtils\.clone\(scene\)/);
  assert.match(parts, /useAnimations\(animations, clone\)/);
  assert.match(parts, /robotClip\(pose, moving\)/);
});

test('C13 the totals strip renders only in 3D mode and read workspaceTotals', () => {
  assert.match(worldView, /<VillageOverlay \/>/);
  assert.match(overlay, /const totals = useWorkspaceTotals\(\);/);
  assert.doesNotMatch(overlay, /buildYardModel|\.filter\(/, 'no derivation of its own');
});

test('the 3D village shows no floating legend box', () => {
  assert.doesNotMatch(overlay, /LEGEND_ROWS|Village legend|<dl/);
});

test('the yard never subscribes to the raw command or test run maps, so log chunks re-derive no yard', () => {
  assert.doesNotMatch(yardHook, /useWorldStore\(\(s\) => s\.(commandRunsById|testRunsById)\)/);
  assert.match(yardHook, /useHeldList\(\(s\) => projectRuns\(s\.commandRunsById, projectId\), sameYardCommandRuns\)/);
  assert.match(yardHook, /useHeldList\(\(s\) => projectRuns\(s\.testRunsById, projectId\), sameYardTestRuns\)/);
  assert.match(yardHook, /useYardSlices\(projectId\)/, 'each yard selects only its own Project\'s runs');
});

test('C14 no polling: the only timer is the once-a-minute elapsed tick, which asks for a frame', () => {
  assert.doesNotMatch(entities + yardFile + parts + overlay, /setInterval/);
  assert.match(entities, /setTimeout\(\(\) => \{ setNow\(Date\.now\(\)\); invalidate\(\); \}, msUntilNextMinute\(item\.startedAt, now\)\)/);
});

test('C15 the command log popup and the Testing run drawer mark a failed run opened when shown', () => {
  assert.match(logPopup, /useEffect\(\(\) => \{ if \(failureUnopened\) void markCommandRunOpened\(runId\); \}, \[failureUnopened, runId, markCommandRunOpened\]\);/);
  assert.match(testing, /useEffect\(\(\) => \{ if \(failureUnopened\) void markTestRunOpened\(runId\); \}, \[failureUnopened, runId, markTestRunOpened\]\);/);
});

test('C16 the docs describe the warehouse + yard and streets, and no Project tower or dome remains', async () => {
  const blueprint = await read('../../docs/blueprint.md');
  const architecture = await read('../../docs/architecture.md');
  const projectBlueprint = await read('../../.docs/blueprint.md');
  for (const doc of [blueprint, projectBlueprint]) {
    assert.match(doc, /warehouse/i);
    assert.match(doc, /street/i);
    assert.doesNotMatch(doc, /ProjectBuilding\.tsx|ProjectWorkers|RobotExpressive|office tower|tinted dome|glossy dome/);
  }
  assert.match(blueprint, /merge-wait/i);
  assert.match(blueprint, /TOWN_SCALE/);
  assert.match(blueprint, /failureUnopened/);
  assert.match(blueprint, /currentLabel/);
  assert.match(architecture, /warehouse/i);
});

test('C17 lit materials everywhere but small glowing parts, so day and night apply', () => {
  const basic = parts.match(/MeshBasicMaterial/g) ?? [];
  assert.equal(basic.length, 1, 'one glow() helper');
  assert.match(parts, /const glow = \(color: string\) => new THREE\.MeshBasicMaterial\(\{ color \}\);/);
  const glowUses = parts.match(/glow\('/g) ?? [];
  assert.ok(glowUses.length <= 7, 'eyes, light strips and laptop screens only');
  assert.match(parts, /YARD_MATERIAL = new THREE\.MeshStandardMaterial/);
  assert.doesNotMatch(parts, /MeshPhysicalMaterial|MeshBasicMaterial\(\{ color: '#/, 'the warehouse uses lit standard materials');
});

// Frustum containment: projects the occupied yards' extreme corners through the default view (DEFAULT_VIEW) (three.js is not installed for tests, so the perspective projection is done by hand).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { yardWorldRect } = await import('../src/lib/villageLayout.ts');
const { PROJECT_PLOTS } = await import('../src/scene/townLayout.ts');

const { DEFAULT_VIEW } = await import('../src/scene/defaultView.ts');
const cameraPosition = [...DEFAULT_VIEW.position];
const cameraTarget = [...DEFAULT_VIEW.target];
const { fov } = DEFAULT_VIEW;
const fogNear = Number(scene.match(/const FOG_NEAR = ([\d.]+);/)?.[1]);
const DOME_HEIGHT = 1.6; // the tallest thing on a yard: its label
const MARGIN = 0.9;

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => a.map((v) => v / Math.hypot(...a));

function project(point, aspect) {
  const forward = unit(sub(cameraTarget, cameraPosition));
  const right = unit(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const rel = sub(point, cameraPosition);
  const depth = dot(rel, forward);
  const f = 1 / Math.tan((fov * Math.PI) / 360);
  return { x: (dot(rel, right) * f) / aspect / depth, y: (dot(rel, up) * f) / depth, depth };
}

// The map is far larger than the camera frame (the camera controls explore the rest), so only the
// yards the first projects fill (the nearest to City Center) must be on screen at the default camera.
const STARTER_PLOTS = 32;
const starterPlots = PROJECT_PLOTS
  .map((plot, index) => ({ plot, index, d: Math.round((plot.x ** 2 + plot.z ** 2) * 1e6) }))
  .sort((a, b) => a.d - b.d || a.index - b.index)
  .slice(0, STARTER_PLOTS)
  .map((entry) => entry.plot);
const cornersOf = (plots) => plots.flatMap((plot) => {
  const [x0, z0, x1, z1] = yardWorldRect([plot.x, plot.z]);
  return [x0, x1].flatMap((x) => [z0, z1].flatMap((z) => [0, DOME_HEIGHT].map((y) => [x, y, z])));
});
const yardCorners = cornersOf(starterPlots);

test('C-cam every starter yard corner (the 32 plots nearest City Center) is on screen at 16:9 and 4:3', () => {
  assert.ok(yardCorners.length > 0);
  for (const aspect of [16 / 9, 4 / 3]) {
    for (const corner of yardCorners) {
      const { x, y, depth } = project(corner, aspect);
      assert.ok(depth > 0 && Math.abs(x) <= MARGIN && Math.abs(y) <= MARGIN, `corner ${corner} projects to (${x.toFixed(2)}, ${y.toFixed(2)}) at aspect ${aspect.toFixed(2)}`);
    }
  }
});

test('C-cam the fog starts beyond the farthest starter yard corner', () => {
  const farthest = Math.max(...yardCorners.map((corner) => Math.hypot(...sub(corner, cameraPosition))));
  assert.ok(fogNear > farthest, `FOG_NEAR ${fogNear} <= farthest corner ${farthest.toFixed(1)}`);
});

test('C-cam the Scene takes its camera and controls target from DEFAULT_VIEW', () => {
  assert.match(scene, /<PerspectiveCamera[^>]*position=\{\[\.\.\.DEFAULT_VIEW\.position\]\}[^>]*fov=\{DEFAULT_VIEW\.fov\}/);
  assert.match(scene, /<MapControls[^>]*target=\{\[\.\.\.DEFAULT_VIEW\.target\]\}/);
  assert.doesNotMatch(scene, /28\.4, 53\.2/);
});

// The Home view looks down at about 36°. With a 40° fov the near edge of the screen is steeper still,
// so "not top-down" is pinned as: no yard is seen from straight above, and the far yards stay well off it.
test('C-cam the Home view looks down at 36 degrees and never straight down at a yard', () => {
  const deg = (rad) => (rad * 180) / Math.PI;
  const [cx, cy, cz] = cameraPosition;
  const elevations = yardCorners.filter((c) => c[1] === 0).map((c) => deg(Math.atan2(cy, Math.hypot(c[0] - cx, c[2] - cz))));
  assert.ok(Math.max(...elevations) <= 80, `steepest ground ray ${Math.max(...elevations).toFixed(1)} deg`);
  assert.ok(Math.min(...elevations) >= 25, `shallowest ground ray ${Math.min(...elevations).toFixed(1)} deg`);
  const [tx, ty, tz] = cameraTarget;
  const centrePitch = deg(Math.atan2(cy - ty, Math.hypot(cx - tx, cz - tz)));
  assert.ok(Math.abs(centrePitch - 36) <= 0.5, `centre pitch ${centrePitch.toFixed(1)} deg`);
});

// ---- Pending stack, zones and the pick-up (task: pending-task stack per Project) ----

test('C01 the yard draws the pending stack at the dock with a pending target; the badge is an overlay hidden at 0, the tooltip from pendingTooltip', () => {
  assert.match(yardFile, /<PendingStack pendingCount=\{yard\.model\.pending\.length\} inTransit=\{transit\.size\} change=\{yard\.stack\} version=\{yard\.version\} onOpen=\{\(\) => openTarget\(\{ kind: 'pending' \}\)\} \/>/);
  assert.match(entities, /userData=\{\{ yardTarget: \{ kind: 'pending' \} satisfies YardTarget \}\}/);
  assert.match(entities, /<group position=\{\[PALLET\.x, 0, PALLET\.z\]\}><Pallet \/><\/group>/);
  assert.match(entities, /\{view\.badge && \(\s*<Html/, 'no badge at 0');
  assert.match(entities, /className="yard-badge"[^>]*onClick=\{onOpen\}/);
  assert.match(entities, /const tooltip = pendingTooltip\(pendingCount\);/);
});

test('C02 each zone has a ground tint and floor word, and the yard styles loop no animation', () => {
  for (const word of ['PENDING', 'PLANNING', 'IN PROGRESS', 'COMMANDS', 'PRs WAITING']) assert.match(parts, new RegExp(`word: '${word}'`));
  assert.match(parts, /for \(const area of Object\.keys\(ZONE_LOOK\) as YardArea\[\]\)/);
  assert.doesNotMatch(parts + entities, /repeat: Infinity|setInterval/);
  const yardCss = css.slice(css.indexOf('.building-type-badge'), css.indexOf('.markdown-document'));
  assert.ok(yardCss.includes('.yard-badge'));
  assert.doesNotMatch(yardCss, /animation(-name)?\s*:/);
});

test('C03 "+N more" markers render for work, commands, merge and planning', () => {
  assert.match(yardFile, /\{SLOT_AREAS\.map\(overflow\)\}/);
  assert.match(yardFile, /<OverflowMarker key=\{`more:\$\{area\}`\} slot=\{SLOTS\[area\]\[AREA_CAPS\[area\]\]!\}/);
});

test('C04 the pick-up uses the existing Robot carrying a Crate; no new robot model', () => {
  assert.match(entities, /case 'pick-up': \{/);
  assert.match(entities, /\{ action: \(\) => \{ setCarrying\(true\); onLift\(\); \} \}/);
  assert.match(entities, /<Robot ref=\{robot\} pose=\{pose\} motion=\{motion\} overhead=\{[^}]*\}>\s*\{carrying \? <Crate \/> : null\}/);
  assert.equal((parts.match(/useGLTF\(/g) ?? []).length, 1, 'one robot model');
  assert.match(parts, /MODEL_PATH = '\/models\/RobotExpressive\.glb'/);
});

test('C05 crate and pallet geometry and materials are module-scope and shared', () => {
  assert.match(parts, /palletDeck: new THREE\.BoxGeometry/);
  assert.match(parts, /pallet: std\('#a97c50'/);
  const pallet = parts.slice(parts.indexOf('export function Pallet'), parts.indexOf('export function OverflowStack'));
  assert.doesNotMatch(pallet, /new THREE\./);
  const stack = entities.slice(entities.indexOf('export function PendingStack'));
  assert.doesNotMatch(stack, /new THREE\./);
});

test('C06 the stack requests frames only while a drop or fade plays', () => {
  const stack = entities.slice(entities.indexOf('export function PendingStack'));
  assert.match(stack, /if \(progress\.current >= 1\) return;/);
  assert.match(stack, /if \(!covered\) state\.invalidate\(\);/);
  assert.match(stack, /progress\.current = drops \+ fades > 0 \? 0 : 1;/);
});

test('C07 the totals strip has a Pending cell read from workspaceTotals', () => {
  assert.match(overlay, /\{ key: 'pending', label: 'Pending', dot: 'yard-dot--pending' \}/);
  assert.match(css, /\.yard-dot--pending \{/);
});

test('C08 with the filter on, Tasks shows a chip with the count and ×, Show all tasks, a wide grid and strips that clear it, with no drops', () => {
  assert.match(tasksPanel, /const pendingOnly = tasksFilter === 'pending'/);
  assert.match(tasksPanel, /Pending only · \{view\.cards\.length\}/);
  assert.match(tasksPanel, /aria-label="Clear the Pending only filter"/);
  assert.match(tasksPanel, />Show all tasks<\/Button>/);
  assert.match(tasksPanel, /grid-cols-\[repeat\(auto-fill,minmax\(15rem,1fr\)\)\]/);
  assert.match(tasksPanel, /<CollapsedColumnStrip key=\{column\}[^>]*onExpand=\{clear\} \/>/);
  assert.match(tasksPanel, /drop=\{NO_DROP\}/);
  assert.match(tasksPanel, /<OpenTaskCard key=\{row\.id\} row=\{row\} agent=\{null\} now=\{now\} handlers=\{handlers\} \/>/, 'no drag handlers');
});

test('C09 the filter reuses the board\'s own planning queue and grouping', () => {
  assert.match(tasksPanel, /pendingOnlyView\(planningQueue, \{ running: boardRunning\.length, needsYou: groups\.needsYou\.length \+ groups\.prNotMerged\.length, done: completedRows\.length \}\)/);
  assert.doesNotMatch(tasksPanel, /pendingTaskRows|buildYardModel/);
});

test('C10 the replaced merge lanes and the command work kind leave no references', async () => {
  const offenders = [];
  for (const file of await sourceFiles('../src/')) {
    const source = await readFile(file, 'utf8');
    if (/mergeApproach|MERGE_SIDE_LANE_X|MERGE_REAR_LANE_Z|MERGE_APPROACH_Z|workKindOf|WorkKind\b|'command'\]/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('C11 the docs describe the five zones, the pending dock and the pick-up', async () => {
  const blueprint = await read('../../docs/blueprint.md');
  for (const words of [/pending dock/i, /apron/i, /PRs waiting|PR queue/i, /commands zone|command machines/i, /Pending only/]) assert.match(blueprint, words);
  assert.match(blueprint, /pick(s)? (it |its crate )?up|lifts/i);
});

test('C12 the stack reads only the pending count; the yard still never subscribes to the raw run maps', () => {
  assert.doesNotMatch(yardHook, /useWorldStore\(\(s\) => s\.(commandRunsById|testRunsById)\)/);
  assert.match(entities, /export function PendingStack\(\{ pendingCount, inTransit, change, version, onOpen \}: PendingStackProps\)/);
  assert.doesNotMatch(entities.slice(entities.indexOf('export function PendingStack')), /useWorldStore\(\(s\) => s\.(planByProject|tasksById|commandRunsById)/);
});

test('K04 the store clears the filter on every openWorkspace call and every tab switch', () => {
  assert.match(store, /workspaceCardDetailRequest: null,\s*workspaceTasksFilter: null,/);
  assert.match(store, /workspaceTab: tab, workspaceTasksFilter: null \}/);
  assert.match(store, /openWorkspacePendingTasks: \(projectId\) => \{\s*get\(\)\.openWorkspace\(projectId\);\s*set\(\{ notificationCenterOpen: false, workspaceTasksFilter: 'pending' \}\);/);
});

test('C13 a pick-up cut short by a stop resets its walk; the stack counts its drops and fades once per change', () => {
  assert.match(entities, /case 'return-to-dome':\s*\/\/[^\n]*\n\s*setCarrying\(false\);\s*setBoxInBay\(true\);/);
  assert.match(yardFile, /setTransit\(survivingTransit\(transit, yard\.layout, yard\.transitions, yard\.pickUps\)\);/);
  const stack = entities.slice(entities.indexOf('export function PendingStack'));
  assert.match(stack, /const \[played, setPlayed\] = useState\(arrived\);/);
  assert.match(stack, /if \(played\.version !== version\) \{\s*counts = arrived\(\);\s*setPlayed\(counts\);/);
});

test('every scene <Html> overlay uses the shared z range, which stays below the top bar', async () => {
  const dir = new URL('../src/scene/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.tsx'));
  for (const f of files) {
    const src = await read(`../src/scene/${f}`);
    assert.doesNotMatch(src, /zIndexRange=\{\[/, `${f} hard-codes a zIndexRange`);
    assert.doesNotMatch(src, /<Html(?![^>]*zIndexRange=\{SCENE_HTML_Z_RANGE\})[^>]*>/, `${f} has an <Html> without the shared zIndexRange`);
  }
  const shared = await read('../src/scene/htmlZIndex.ts');
  const max = Number(shared.match(/SCENE_HTML_Z_RANGE: \[number, number\] = \[(\d+),/)[1]);
  const headerZ = Number(topBar.match(/absolute[^"]*\bz-(\d+)\b/)[1]);
  assert.ok(max < headerZ, `scene Html max ${max} must be below the header z-${headerZ}`);
});
