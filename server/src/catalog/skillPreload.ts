/**
 * Which of a Task's or Workflow step's attached skills load their full SKILL.md
 * into the system prompt ("always load"); every other attached skill is only
 * listed in an index for the agent to Read on demand. Absent or empty means
 * every attached skill is on demand.
 */

/** Why `preloadSkillIds` is invalid for `skillIds`, or null when it is acceptable (absent included). */
export function preloadSkillsProblem(skillIds: unknown, preloadSkillIds: unknown): string | null {
  if (preloadSkillIds === undefined) return null;
  if (!Array.isArray(preloadSkillIds) || preloadSkillIds.some((id) => typeof id !== 'string')) {
    return 'preloadSkillIds must be an array of strings';
  }
  const attached = new Set(Array.isArray(skillIds) ? skillIds : []);
  const stray = preloadSkillIds.find((id) => !attached.has(id));
  return stray === undefined ? null : `preloadSkillIds must be a subset of skillIds: "${stray}" is not an attached skill`;
}
