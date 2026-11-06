import { useMemo } from 'react';
import { useWorldStore } from '../store/worldStore';
import { useFooterBoards } from './useFooterBoards';
import { useNow } from '../lib/useNow';
import { EMPTY_RUNNING_MESSAGE, buildRunningGroups, runningElapsed, runningStopLabel } from '../lib/runningCommands';
import type { RunningRow } from '../lib/runningCommands';
import { seoTabForJob } from '../lib/seoWorkspace';
import { FooterListHeading } from './FooterListHeading';
import {
  EMPTY_PROJECT_MESSAGES,
  buildProjectRows,
  projectRowCounts,
} from '../lib/footerPopovers';
import type { FooterProjectKind } from '../lib/footerPopovers';

const ROW = 'flex w-full min-w-0 flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent';

const Empty = ({ children }: { children: string }) => <p className="px-2 py-2 italic text-muted-foreground">{children}</p>;

/** The projects behind a footer "working" or "blocked" number, A–Z; a row opens that project's Tasks board. */
export function ProjectListPopover({ kind, onDone }: { kind: FooterProjectKind; onDone: () => void }) {
  const boards = useFooterBoards();
  const openCard = useWorldStore((s) => s.openWorkspaceCardDetail);
  const rows = useMemo(() => buildProjectRows(boards, kind), [boards, kind]);
  if (rows.length === 0) return <Empty>{EMPTY_PROJECT_MESSAGES[kind]}</Empty>;
  return (
    <ul>
      {rows.map((row) => {
        const counts = projectRowCounts(row);
        return (
          <li key={row.projectId}>
            <button type="button" className={ROW} aria-label={counts ? `${row.name}, ${counts}` : row.name} onClick={() => { openCard(row.projectId, null); onDone(); }}>
              <span className="truncate font-medium" title={row.name}>{row.name}</span>
              {counts && <span className="truncate text-[11px] text-muted-foreground">{counts}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const TAG = 'flex-none rounded-sm border border-border px-1 text-[10px] font-medium leading-4';

/** Everything running behind the footer's Commands number, under project headings A–Z; a row opens its log (or, for a test run, its drawer). */
export function CommandsListPopover({ onDone }: { onDone: () => void }) {
  const projects = useWorldStore((s) => s.projects);
  const commandRunsById = useWorldStore((s) => s.commandRunsById);
  const testRunsById = useWorldStore((s) => s.testRunsById);
  const seoJobsById = useWorldStore((s) => s.seoJobsById);
  const contentJobsById = useWorldStore((s) => s.contentJobsById);
  const openSeoFromFooter = useWorldStore((s) => s.openSeoFromFooter);
  const stopSeoCrawl = useWorldStore((s) => s.stopSeoCrawlFromFooter);
  const stopRender = useWorldStore((s) => s.stopRenderFromFooter);
  const stopImageRender = useWorldStore((s) => s.stopImageRenderFromFooter);
  const stopThumbnailRender = useWorldStore((s) => s.stopThumbnailRenderFromFooter);
  const stopStudio = useWorldStore((s) => s.stopStudioFromFooter);
  const stopInsights = useWorldStore((s) => s.stopInsightsFromFooter);
  const openWorkspace = useWorldStore((s) => s.openWorkspace);
  const openFooterCommandLog = useWorldStore((s) => s.openFooterCommandLog);
  const openTestRunFromFooter = useWorldStore((s) => s.openTestRunFromFooter);
  const now = useNow(1_000);
  const groups = useMemo(() => buildRunningGroups({ projects, commandRunsById, testRunsById, seoJobsById, contentJobsById }), [projects, commandRunsById, testRunsById, seoJobsById, contentJobsById]);
  if (groups.length === 0) return <Empty>{EMPTY_RUNNING_MESSAGE}</Empty>;
  const stopRow = (row: RunningRow) => {
    if (row.kind === 'seo') return stopSeoCrawl(row.projectId);
    if (row.contentKind === 'remotion-studio') return stopStudio(row.projectId);
    if (row.contentKind === 'insights') return stopInsights(row.projectId);
    if (row.contentKind === 'thumbnail') return stopThumbnailRender(row.projectId, row.assetId!, row.runId);
    return row.assetId ? stopImageRender(row.projectId, row.assetId, row.runId) : stopRender(row.projectId, row.conceptId!, row.runId);
  };
  const open = (row: RunningRow) => {
    onDone();
    if (row.kind === 'command') void openFooterCommandLog(row.runId);
    else if (row.kind === 'seo') openSeoFromFooter(row.projectId, seoTabForJob(row.jobKind!));
    else if (row.kind === 'content') openWorkspace(row.projectId);
    else void openTestRunFromFooter(row.projectId, row.runId);
  };
  return (
    <>
      {groups.map((group) => (
        <section key={group.projectId} aria-label={group.projectName}>
          <FooterListHeading name={group.projectName} count={group.rows.length} />
          <ul>
            {group.rows.map((row) => {
              const elapsed = row.queued ? 'Queued' : runningElapsed(row.startedAt, now);
              return (
                <li key={row.key} className="flex items-center gap-1">
                  <button type="button" className={ROW} aria-label={[row.name, row.kind === 'test' ? 'test run' : null, row.startedByAgent ? 'started by agent' : null, row.progress, row.where, row.queued ? 'queued' : `running ${elapsed}`].filter(Boolean).join(', ')} onClick={() => open(row)}>
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium" title={row.name}>{row.name}</span>
                      <span className="flex-none text-[11px] tabular-nums text-muted-foreground">{elapsed}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      {row.kind === 'test' && <span className={TAG}>Test run</span>}
                      {row.startedByAgent && <span className={`${TAG} border-info/50 text-info-foreground`}>started by agent</span>}
                      <span className="truncate" title={row.where}>{row.where}</span>
                      {row.progress && <span className="flex-none tabular-nums">{row.progress}</span>}
                    </span>
                  </button>
                  {row.stoppable && (
                    <button type="button" className="flex-none rounded-sm border border-border px-2 py-1 text-[11px] font-medium outline-none hover:bg-accent focus-visible:bg-accent" aria-label={runningStopLabel(row, group.projectName)} onClick={(event) => { event.stopPropagation(); void stopRow(row); }}>
                      Stop
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
