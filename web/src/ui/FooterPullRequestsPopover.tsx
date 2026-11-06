import { useWorldStore } from '../store/worldStore';
import { EMPTY_PRS_MESSAGE, lastCheckedText, ageLabel, moreRowText, prRowAccessibleName, unavailableRowText } from '../lib/footerPullRequests';
import type { FooterPrGroup, FooterPrSummary } from '../lib/footerPullRequests';
import { refreshAllPullRequests } from '../lib/useFooterPullRequests';
import { useNow } from '../lib/useNow';
import { FooterListHeading } from './FooterListHeading';

const ROW = 'flex w-full min-w-0 flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent';
const NOTE_ROW = 'px-2 py-1.5 text-[11px] text-muted-foreground';
const TAG = 'flex-none rounded-sm border border-border px-1 text-[10px] font-medium leading-4';

function GroupRows({ group, now, onOpen }: { group: FooterPrGroup; now: number; onOpen: (projectId: string, number: number | null) => void }) {
  return (
    <ul>
      {group.state === 'checking' && <li className={`${NOTE_ROW} italic`}>Checking…</li>}
      {group.state === 'unavailable' && <li className={NOTE_ROW}>{unavailableRowText(group.reason)}</li>}
      {group.rows.map((row) => {
        const age = ageLabel(row.createdAt, now);
        return (
          <li key={row.number}>
            <button type="button" className={ROW} aria-label={prRowAccessibleName(row, group.projectName)} onClick={() => onOpen(group.projectId, row.number)}>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-medium" title={row.title}>#{row.number} {row.title}</span>
                {age && <span className="flex-none text-[11px] tabular-nums text-muted-foreground">{age}</span>}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                {row.isDraft && <span className={TAG}>Draft</span>}
                <span className="truncate" title={row.branches}>{row.branches}</span>
                {row.author && <span className="flex-none">· {row.author}</span>}
              </span>
            </button>
          </li>
        );
      })}
      {group.hiddenCount > 0 && (
        <li>
          <button type="button" className={`${ROW} text-[11px] text-muted-foreground`} onClick={() => onOpen(group.projectId, null)}>{moreRowText(group.hiddenCount)}</button>
        </li>
      )}
    </ul>
  );
}

/** Open pull requests behind the footer's PRs number, under project headings A–Z; a row opens that project's PR tab at that pull request. */
export function PullRequestsListPopover({ summary, onDone }: { summary: FooterPrSummary; onDone: () => void }) {
  const open = useWorldStore((s) => s.openPullRequestFromFooter);
  const now = useNow(30_000);
  const checked = lastCheckedText(summary.oldestCheckedAt, now);
  const onOpen = (projectId: string, number: number | null) => { onDone(); open(projectId, number); };
  return (
    <>
      {summary.groups.length === 0 ? (
        <p className="px-2 py-2 italic text-muted-foreground">{EMPTY_PRS_MESSAGE}</p>
      ) : summary.groups.map((group) => (
        <section key={group.projectId} aria-label={group.projectName}>
          <FooterListHeading name={group.projectName} count={group.state === 'ready' ? group.count : undefined} />
          <GroupRows group={group} now={now} onOpen={onOpen} />
        </section>
      ))}
      <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-border bg-popover px-2 py-1.5 text-[11px] text-muted-foreground">
        <span>{checked.text}{checked.stale ? ' — older than usual' : ''}</span>
        <button type="button" className="rounded-sm border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:bg-accent" onClick={refreshAllPullRequests}>Refresh all</button>
      </div>
    </>
  );
}
