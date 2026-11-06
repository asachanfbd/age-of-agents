export function isTaskTerminalTarget(target: EventTarget | null): boolean {
  if (!target || !('closest' in target) || typeof target.closest !== 'function') return false;
  return target.closest('[data-task-terminal]') !== null;
}
