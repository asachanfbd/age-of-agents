import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  SOUND_MUTED_STORAGE_KEY, getSoundsMuted, readSoundsMuted, setSoundsMuted, subscribeSoundsMuted, writeSoundsMuted,
} from '../src/lib/soundPreference.ts';

const preferencesSource = await readFile(new URL('../src/ui/PreferencesSettings.tsx', import.meta.url), 'utf8');
const taskSoundsSource = await readFile(new URL('../src/ui/TaskSounds.tsx', import.meta.url), 'utf8');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

const throwingStorage = {
  getItem() { throw new Error('storage blocked'); },
  setItem() { throw new Error('quota exceeded'); },
};

test('sounds are unmuted by default', () => {
  assert.equal(readSoundsMuted(memoryStorage()), false);
  assert.equal(readSoundsMuted(undefined), false);
});

test('only a stored "true" means muted', () => {
  assert.equal(readSoundsMuted(memoryStorage({ [SOUND_MUTED_STORAGE_KEY]: 'true' })), true);
  assert.equal(readSoundsMuted(memoryStorage({ [SOUND_MUTED_STORAGE_KEY]: 'false' })), false);
  assert.equal(readSoundsMuted(memoryStorage({ [SOUND_MUTED_STORAGE_KEY]: 'yes' })), false);
});

test('writeSoundsMuted round-trips through storage', () => {
  const storage = memoryStorage();
  writeSoundsMuted(true, storage);
  assert.equal(storage.values.get(SOUND_MUTED_STORAGE_KEY), 'true');
  assert.equal(readSoundsMuted(storage), true);
  writeSoundsMuted(false, storage);
  assert.equal(readSoundsMuted(storage), false);
});

test('storage failures fall back to unmuted and never throw', () => {
  assert.equal(readSoundsMuted(throwingStorage), false);
  assert.doesNotThrow(() => writeSoundsMuted(true, throwingStorage));
});

test('setSoundsMuted updates the cached value and notifies subscribers until unsubscribed', () => {
  assert.equal(getSoundsMuted(), false);
  let calls = 0;
  const unsubscribe = subscribeSoundsMuted(() => { calls += 1; });
  setSoundsMuted(true);
  assert.equal(getSoundsMuted(), true);
  assert.equal(calls, 1);
  unsubscribe();
  setSoundsMuted(false);
  assert.equal(getSoundsMuted(), false);
  assert.equal(calls, 1);
});

test('Preferences renders the mute switch bound to the sound preference', () => {
  assert.match(preferencesSource, /<Switch id="mute-sounds" checked=\{soundsMuted\} onCheckedChange=\{setSoundsMuted\} \/>/);
});

test('TaskSounds skips playback while muted', () => {
  assert.match(taskSoundsSource, /if \(getSoundsMuted\(\)\) return;/);
});
