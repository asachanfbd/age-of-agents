/**
 * Suggests a default project name so "Create Project" never opens on a blank,
 * pressure-filled input — the user can accept the suggestion or type their
 * own. Deliberately not cryptographically random; this is naming flavor, not
 * an id (real ids come from the server).
 */
const ADJECTIVES = [
  'Crimson', 'Amber', 'Azure', 'Silent', 'Rapid', 'Lunar', 'Solar', 'Cobalt',
  'Rogue', 'Quiet', 'Bright', 'Iron', 'Violet', 'Golden', 'Arctic', 'Nimble',
];

const NOUNS = [
  'Falcon', 'Comet', 'Otter', 'Harbor', 'Ember', 'Compass', 'Lantern', 'Rover',
  'Summit', 'Beacon', 'Voyager', 'Thicket', 'Cascade', 'Anchor', 'Ridge', 'Fox',
];

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('codename: word list is empty');
  return item;
}

/** `random` is injectable so tests can assert a specific outcome instead of a pattern. */
export function generateCodename(random: () => number = Math.random): string {
  return `${pick(ADJECTIVES, random)} ${pick(NOUNS, random)}`;
}
