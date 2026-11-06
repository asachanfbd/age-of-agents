import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Platform } from '../../lib/contentRules';
import type { ConceptDto, PostDto } from '../../lib/contentTypes';
import {
  blogCounter, contextLine, copyLabelFor, copyTextFor, defaultPostId, finalizedNote, nextChipIndex, postChipModel, postsForTab, selectedPostId, switcherLabel, textAssetOf, textCounters, threadView,
} from '../../lib/contentPostTabs';
import type { Counter, PostChipModel, PostTextTab as PostTextTabKey } from '../../lib/contentPostTabs';
import { RelativeTime } from '../design/RelativeTime';
import { MarkdownDocument } from '../MarkdownDocument';
import { AssetStateLabel, PlatformIcon } from './shared';
import { copyToClipboard } from './StudioPaneView';
import type { StudioResultFormat } from './StudioPaneView';

export type BlogView = 'rendered' | 'raw';

const RESULT_BOX = 'm-0 min-h-[12rem] rounded-card border border-border p-3 text-sm [overflow-wrap:anywhere]';

function CounterRow({ counter, meter = true }: { counter: Counter; meter?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground" data-counter data-near={counter.near || undefined}>
      <span className="font-medium tabular-nums text-foreground">{counter.label}</span>
      {meter && <span aria-hidden="true" className="h-1 min-w-20 flex-1 overflow-hidden rounded-full bg-muted"><span className={cn('block h-full', counter.near ? 'bg-warning' : 'bg-success')} style={{ width: `${counter.percent}%` }} /></span>}
      <span className={cn(counter.near && 'font-medium text-warning-foreground')}>{counter.status}</span>
    </div>
  );
}

function ThreadCards({ text }: { text: string }) {
  const thread = threadView(text);
  return (
    <div className="grid gap-2">
      <p className="m-0 text-xs text-muted-foreground" data-thread-heading>{thread.heading}</p>
      <ol className="m-0 grid list-none gap-2 p-0" aria-label="Tweets" data-result>
        {thread.tweets.map((tweet) => (
          <li key={tweet.index} className="grid gap-1 rounded-card border border-border px-3 pb-2.5 pt-2" data-tweet={tweet.index + 1}>
            <header className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{tweet.label}</span>
              <span className="inline-flex items-center gap-2">
                <span className={cn('tabular-nums', tweet.counter.near && 'font-medium text-warning-foreground')}>{tweet.counter.label}</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={tweet.copyLabel} title={tweet.copyLabel} onClick={() => void copyToClipboard(tweet.text)}><Copy aria-hidden="true" /></Button>
              </span>
            </header>
            <p className="m-0 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{tweet.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function BlogViewToggle({ view, onView }: { view: BlogView; onView: (view: BlogView) => void }) {
  const option = (value: BlogView, label: string) => <Button type="button" size="sm" variant={view === value ? 'secondary' : 'ghost'} aria-pressed={view === value} onClick={() => onView(value)}>{label}</Button>;
  return <span role="group" aria-label="Article view" className="inline-flex rounded-md border border-border p-0.5">{option('rendered', 'Rendered')}{option('raw', 'Raw Markdown')}</span>;
}

function FinalizedNote({ platform, onOverview }: { platform: Platform; onOverview: () => void }) {
  const note = finalizedNote(platform);
  return <p className="m-0 text-xs text-muted-foreground" data-finalized-note>{note.before}<button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-xs text-foreground underline" onClick={onOverview}>{note.link}</button>{note.after}</p>;
}

/** How a post's text is drawn in the studio pane for its platform: counters, X thread cards, the blog's Markdown with its toggle. */
export function postResultFormat(platform: Platform, options: { blogView: BlogView; onBlogView: (view: BlogView) => void; onOverview: () => void }): StudioResultFormat {
  const plain = (text: string) => <pre className={cn(RESULT_BOX, 'whitespace-pre-wrap font-sans')} data-result>{text}</pre>;
  const body = (text: string): ReactNode => {
    if (platform === 'x') return <ThreadCards text={text} />;
    if (platform === 'blog') {
      return (
        <div className="grid gap-2">
          {options.blogView === 'rendered' ? <div className={cn(RESULT_BOX, 'markdown-document')} data-result><MarkdownDocument content={text} /></div> : plain(text)}
          <CounterRow counter={{ label: blogCounter(text), status: '', near: false, percent: 0 }} meter={false} />
        </div>
      );
    }
    return <div className="grid gap-2">{plain(text)}{textCounters(platform, text).map((c) => <CounterRow key={c.label} counter={c} />)}</div>;
  };
  return {
    copyLabel: (text) => copyLabelFor(platform, text),
    copyText: (text) => copyTextFor(platform, text),
    controls: platform === 'blog' ? <BlogViewToggle view={options.blogView} onView={options.onBlogView} /> : undefined,
    body,
    finalizedNote: <FinalizedNote platform={platform} onOverview={options.onOverview} />,
  };
}

/**
 * The chips of the posts a tab covers; works as a tablist where only the selected chip is a Tab stop. A chip shows its post text's
 * state unless `chipOf` says otherwise (the Images tab shows the image set's), and `label` replaces the text tab's heading.
 */
export function PostSwitcher({ tab, posts, selectedId, timeZone, onSelect, now, label, chipOf = postChipModel }: {
  tab: PostTextTabKey | 'images'; posts: PostDto[]; selectedId: string | null; timeZone: string; onSelect: (id: string) => void; now?: number; label?: string; chipOf?: (post: PostDto) => PostChipModel;
}) {
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  const labelId = `post-switcher-${tab}`;
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = posts.findIndex((p) => p.id === selectedId);
    const next = nextChipIndex(index, posts.length, event.key);
    if (next === index) return;
    event.preventDefault();
    onSelect(posts[next]!.id);
    chips.current[next]?.focus();
  };
  return (
    <section className="grid gap-2" aria-label="Post switcher">
      <p id={labelId} className="m-0 text-xs text-muted-foreground">{label ?? switcherLabel(tab as PostTextTabKey, posts.length)}</p>
      <div role="tablist" aria-labelledby={labelId} className="flex flex-wrap gap-2" onKeyDown={onKeyDown}>
        {posts.map((post, i) => {
          const chip = chipOf(post);
          const on = post.id === selectedId;
          return (
            <button key={post.id} ref={(el) => { chips.current[i] = el; }} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} data-post={post.id}
              className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs', on ? 'border-2 border-foreground bg-accent' : 'border-border')}
              onClick={() => onSelect(post.id)}>
              <PlatformIcon platform={chip.platform} />
              <span>{chip.format}</span>
              <span className="text-muted-foreground">· <RelativeTime at={chip.scheduledAt} timeZone={timeZone} now={now} /></span>
              <AssetStateLabel state={chip.state} />
            </button>
          );
        })}
      </div>
    </section>
  );
}

export interface PostTextTabProps {
  tab: PostTextTabKey;
  concept: ConceptDto;
  timeZone: string;
  /** Draws the studio pane of the selected post's text asset. */
  renderStudio: (conceptId: string, assetId: string, format: StudioResultFormat) => ReactNode;
  onOverview: () => void;
  /** Pins the clock (tests). */
  now?: number;
}

/**
 * Post content, Captions or Blog: a post switcher over the tab's posts and the studio pane of the selected post's text.
 * The choice is not remembered; switching posts leaves the other post's session running.
 */
export function PostTextTab({ tab, concept, timeZone, renderStudio, onOverview, now }: PostTextTabProps) {
  const posts = postsForTab(concept.posts, tab);
  // The default is taken once, when the tab opens: finalizing the shown text must not move the selection (and start another post's session).
  const [chosen, setChosen] = useState<string | null>(() => defaultPostId(posts));
  const [blogView, setBlogView] = useState<BlogView>('rendered');
  const selectedId = selectedPostId(posts, chosen);
  // A fallback (the chosen post was deleted) is pinned too, so it does not move again when states change.
  useEffect(() => { if (selectedId !== chosen) setChosen(selectedId); }, [selectedId, chosen]);
  const post = posts.find((p) => p.id === selectedId);
  const asset = post && textAssetOf(post);
  if (!post || !asset) return null;
  const context = contextLine(post, timeZone);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 gap-3 border-b border-border px-4 py-3 sm:px-6" aria-label="Post context">
        <PostSwitcher tab={tab} posts={posts} selectedId={selectedId} timeZone={timeZone} onSelect={setChosen} now={now} />
        <p className="m-0 text-sm" data-context><b>{context.title}</b> · {context.rest}</p>
      </div>
      {renderStudio(concept.id, asset.id, postResultFormat(post.platform, { blogView, onBlogView: setBlogView, onOverview }))}
    </div>
  );
}
