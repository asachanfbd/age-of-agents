import { repositoryLinkOf } from '../../lib/gitProvider';
import type { ProjectData } from '../../types';

/** Icon link to the Project's repository on its Git provider, in a new browser tab. Hidden when the provider doesn't recognise the repository URL. */
export function RepositoryLink({ project }: { project: ProjectData }) {
  const link = repositoryLinkOf(project);
  if (!link) return null;
  return (
    <a href={link.repository} target="_blank" rel="noopener noreferrer" aria-label={`Open GitHub repository ${link.slug} in a new tab`} title={link.slug} className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background shadow-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .7a11.3 11.3 0 0 0-3.57 22.02c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.31-1.25-1.66-1.25-1.66-1.02-.7.08-.68.08-.68 1.13.08 1.73 1.16 1.73 1.16 1.01 1.72 2.65 1.22 3.29.93.1-.73.39-1.22.71-1.5-2.5-.29-5.13-1.25-5.13-5.58 0-1.23.44-2.24 1.16-3.03-.12-.29-.5-1.44.11-3 0 0 .95-.31 3.11 1.15a10.8 10.8 0 0 1 5.66 0c2.16-1.46 3.1-1.15 3.1-1.15.62 1.56.24 2.71.12 3 .73.79 1.16 1.8 1.16 3.03 0 4.34-2.64 5.29-5.15 5.57.4.35.75 1.03.75 2.08v3.09c0 .3.2.65.78.54A11.3 11.3 0 0 0 12 .7Z" /></svg>
    </a>
  );
}
