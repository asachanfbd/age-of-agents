import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { WRENCH_AMPLITUDE, WRENCH_PERIOD_SECONDS, isOneShot, robotClip, wrenchSwing, wrenchVisible } from '../src/scene/robotClips.ts';

const POSES = ['idle', 'work', 'wait', 'carry', 'sit', 'seated'];

test('a walking robot plays Walking whatever its pose', () => {
  for (const pose of POSES) assert.equal(robotClip(pose, true), 'Walking', pose);
});

test('a standing robot plays the clip for its pose', () => {
  assert.deepEqual(POSES.map((pose) => robotClip(pose, false)), ['Idle', 'Idle', 'Wave', 'Idle', 'Sitting', 'Sitting']);
});

test('only Sitting is a one-shot clip', () => {
  assert.equal(isOneShot('Sitting'), true);
  for (const clip of ['Idle', 'Walking', 'Wave']) assert.equal(isOneShot(clip), false, clip);
});

test('every clip a robot can play exists in the model file', async () => {
  const glb = await readFile(new URL('../public/models/RobotExpressive.glb', import.meta.url));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  const names = json.animations.map((a) => a.name);
  for (const pose of POSES) for (const moving of [true, false]) assert.ok(names.includes(robotClip(pose, moving)), `${pose}/${moving}`);
});

test('no pose ever plays an aggressive clip', () => {
  for (const pose of POSES) for (const moving of [true, false]) assert.notEqual(robotClip(pose, moving), 'Punch');
});

test('only waiting plays Wave', () => {
  assert.deepEqual(POSES.filter((pose) => robotClip(pose, false) === 'Wave'), ['wait']);
});

test('the model has the arm bones the wrench rides on', async () => {
  const glb = await readFile(new URL('../public/models/RobotExpressive.glb', import.meta.url));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  const names = json.nodes.map((n) => n.name);
  assert.ok(names.includes('Hand.R'));
  assert.ok(names.includes('LowerArm.R'));
});

test('the wrench swing starts at rest, stays within its amplitude and repeats every period', () => {
  assert.equal(wrenchSwing(0), 0);
  for (const t of [-3.7, 0, 0.4, 1.1, 99.9, 1e7]) {
    assert.ok(Number.isFinite(wrenchSwing(t)), String(t));
    assert.ok(Math.abs(wrenchSwing(t)) <= WRENCH_AMPLITUDE + 1e-9, String(t));
  }
  assert.ok(Math.abs(wrenchSwing(0.7) - wrenchSwing(0.7 + WRENCH_PERIOD_SECONDS)) < 1e-9);
});

test('the wrench swing is slow: it never moves more than 0.02 rad in one 60 fps frame', () => {
  let worst = 0;
  for (let t = 0; t < WRENCH_PERIOD_SECONDS * 2; t += 1 / 60) worst = Math.max(worst, Math.abs(wrenchSwing(t + 1 / 60) - wrenchSwing(t)));
  assert.ok(worst < 0.02, String(worst));
});

test('the wrench shows only for a standing working robot', () => {
  for (const pose of POSES) assert.equal(wrenchVisible(pose, false), pose === 'work', pose);
  for (const pose of POSES) assert.equal(wrenchVisible(pose, true), false, pose);
});

test('the wrench is built per robot clone on its right hand and no scene source mentions Punch', async () => {
  const parts = await readFile(new URL('../src/scene/yardParts.tsx', import.meta.url), 'utf8');
  const sceneDir = new URL('../src/scene/', import.meta.url);
  const sources = await Promise.all((await readdir(sceneDir)).filter((name) => /\.tsx?$/.test(name)).map((name) => readFile(new URL(name, sceneDir), 'utf8')));
  assert.match(parts, /clone\.getObjectByName\('Hand\.R'\)/);
  assert.match(parts, /rig\.wrench\.visible = turning;/);
  assert.doesNotMatch(sources.join('\n'), /Punch/);
});
