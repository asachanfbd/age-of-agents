import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PROJECT_PLOTS, migrateLegacyPlot } from '../src/projects/townPlots.ts';

// Point the daemon's file-based database and project folders at a throwaway
// temp directory before anything under src/ is imported — see config.ts's
// AGENT_VISUAL_OS_PROJECTS_DIR / AGENT_VISUAL_OS_DATA_DIR overrides. node's
// test runner isolates each file in its own process, so this never leaks
// into another test file.
let projectService: typeof import('../src/projects/projectService.ts');
let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'project-service-test-'));
  process.env.AGENT_VISUAL_OS_PROJECTS_DIR = path.join(tempRoot, 'projects');
  process.env.AGENT_VISUAL_OS_DATA_DIR = path.join(tempRoot, 'data');
  projectService = await import('../src/projects/projectService.ts');
});

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test('createProject makes a real folder with no .docs scaffold folders and no placeholder doc content', async () => {
  const project = await projectService.createProject({ name: 'My Cool App', position: [1, 2] });

  assert.equal(project.name, 'My Cool App');
  assert.equal(project.slug, 'my-cool-app');
  assert.equal(project.status, 'idle');
  assert.equal(project.activeTaskId, null);
  assert.equal(project.taskCount, 0);
  assert.deepEqual(project.position, [1, 2]);

  const root = projectService.projectAbsolutePath(project);
  for (const unused of ['notes', 'decision-logs', 'tasks', 'milestones']) {
    assert.equal(await exists(path.join(root, '.docs', unused)), false, `.docs/${unused} is no longer scaffolded`);
  }
  // No blueprint.md and no plan/ stub docs — real .docs content comes from the
  // docs-bootstrap Task (startDocsBootstrapTask), not a dummy file written here.
  assert.equal(await exists(path.join(root, '.docs', 'blueprint.md')), false);
  assert.equal(await exists(path.join(root, '.docs', 'plan')), false);
});

test('createProject de-duplicates slugs for the same name', async () => {
  const first = await projectService.createProject({ name: 'Duplicate Name', position: null });
  const second = await projectService.createProject({ name: 'Duplicate Name', position: null });
  assert.equal(first.slug, 'duplicate-name');
  assert.equal(second.slug, 'duplicate-name-2');
});

test('getProject throws ProjectNotFoundError for an unknown id', async () => {
  await assert.rejects(() => projectService.getProject('does-not-exist'), projectService.ProjectNotFoundError);
});

test('listProjects includes every created project', async () => {
  const project = await projectService.createProject({ name: 'Listed Project', position: null });
  const all = await projectService.listProjects();
  assert.ok(all.some((p) => p.id === project.id));
});

test('updateProjectPosition persists a new position', async () => {
  const project = await projectService.createProject({ name: 'Movable', position: [0, 0] });
  const moved = await projectService.updateProjectPosition(project.id, PROJECT_PLOTS[5]!);
  assert.deepEqual(moved.position, PROJECT_PLOTS[5]!);
  assert.deepEqual((await projectService.getProject(project.id)).position, PROJECT_PLOTS[5]!);
});

test('updateProjectPosition refuses non-plots and plots another project holds', async () => {
  const holder = await projectService.createProject({ name: 'Plot Holder', position: PROJECT_PLOTS[7]! });
  const mover = await projectService.createProject({ name: 'Plot Seeker', position: null });
  await assert.rejects(projectService.updateProjectPosition(mover.id, [5, 6]), projectService.InvalidPlotError);
  await assert.rejects(projectService.updateProjectPosition(mover.id, holder.position), projectService.PlotTakenError);
  await assert.rejects(projectService.updateProjectPosition('missing', PROJECT_PLOTS[5]!), projectService.ProjectNotFoundError);
});

test('S05 the invalid-plot message names the 240 plots, not 32', () => {
  assert.match(new projectService.InvalidPlotError().message, /240/);
  assert.doesNotMatch(new projectService.InvalidPlotError().message, /32/);
});

test('I07 a stale client sending a block-grid coordinate is moved to that coordinate\'s street plot', async () => {
  const project = await projectService.createProject({ name: 'Stale Client', position: null });
  const target = migrateLegacyPlot([-4.38, -4.38]);
  assert.ok(target);
  const moved = await projectService.updateProjectPosition(project.id, [-4.38, -4.38]);
  assert.deepEqual(moved.position, target);
});

test('I08 migrateLegacyPositions moves block-grid positions once, keeps null and street positions, and a second run changes nothing', async () => {
  const legacy = await projectService.createProject({ name: 'Old Grid', position: [0.78, 4.38] });
  const unplaced = await projectService.createProject({ name: 'No Position', position: null });
  const onStreet = await projectService.createProject({ name: 'On Street', position: PROJECT_PLOTS[200]! });
  const target = migrateLegacyPlot([0.78, 4.38]);
  assert.ok(target && PROJECT_PLOTS.some((plot) => plot[0] === target[0] && plot[1] === target[1]));
  assert.ok(await projectService.migrateLegacyPositions() >= 1);
  assert.deepEqual((await projectService.getProject(legacy.id)).position, target);
  assert.equal((await projectService.getProject(unplaced.id)).position, null);
  assert.deepEqual((await projectService.getProject(onStreet.id)).position, PROJECT_PLOTS[200]!);
  assert.equal(await projectService.migrateLegacyPositions(), 0);
});

test('I08 a block-grid position whose street plot another project already holds is skipped, not duplicated', async () => {
  const target = migrateLegacyPlot([4.38, -0.78]);
  assert.ok(target);
  const holder = await projectService.createProject({ name: 'Holds Target', position: target });
  const legacy = await projectService.createProject({ name: 'Blocked Legacy', position: [4.38, -0.78] });
  await projectService.migrateLegacyPositions();
  assert.deepEqual((await projectService.getProject(holder.id)).position, target);
  assert.deepEqual((await projectService.getProject(legacy.id)).position, [4.38, -0.78]);
});

test('patchProject and setProjectStatus update the fields they target and leave others alone', async () => {
  const project = await projectService.createProject({ name: 'Status Flip', position: null });
  const developing = await projectService.setProjectStatus(project.id, 'developing');
  assert.equal(developing.status, 'developing');
  assert.equal(developing.id, project.id);

  const withTask = await projectService.patchProject(project.id, { activeTaskId: 'task-1', taskCount: 1 });
  assert.equal(withTask.activeTaskId, 'task-1');
  assert.equal(withTask.taskCount, 1);
  assert.equal(withTask.status, 'developing');
});

test('deleteProject refuses while a task is active, and removes the folder once cleared', async () => {
  const project = await projectService.createProject({ name: 'Deletable', position: null });
  const root = projectService.projectAbsolutePath(project);
  await projectService.patchProject(project.id, { activeTaskId: 'task-1' });

  await assert.rejects(() => projectService.deleteProject(project.id), projectService.ProjectHasActiveTaskError);
  assert.ok(await exists(root));

  await projectService.patchProject(project.id, { activeTaskId: null });
  await projectService.deleteProject(project.id);

  assert.equal(await exists(root), false);
  await assert.rejects(() => projectService.getProject(project.id), projectService.ProjectNotFoundError);
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});
