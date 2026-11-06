/**
 * Creates a Project through the service rather than POST /api/projects, which also creates and starts the
 * 'Set up project documentation' item and would put a run (and its queue entry) on the Project. Resolves in
 * the `{ status, body }` shape of an API response so call sites read the same.
 * Imports the service lazily: it must load after the test file has set its data directory.
 */
export async function createQuietProject(name: string): Promise<{ status: 201; body: Awaited<ReturnType<typeof import('../../src/projects/projectService.ts').createProject>> }> {
  const { createProject } = await import('../../src/projects/projectService.ts');
  return { status: 201, body: await createProject({ name, position: null }) };
}
