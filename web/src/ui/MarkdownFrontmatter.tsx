import { Fragment } from 'react';
import { frontmatterValueText } from '../lib/markdownFrontmatter';
import type { FrontmatterEntry, FrontmatterValue } from '../lib/markdownFrontmatter';
import { CopyButton } from './CopyButton';

/** A markdown file's YAML frontmatter as a bordered key/value table, one row per key, each value copyable. */
export function MarkdownFrontmatter({ entries }: { entries: FrontmatterEntry[] }) {
  return (
    <dl className="markdown-frontmatter mb-6 grid grid-cols-[max-content_minmax(0,1fr)] overflow-hidden rounded-lg border text-sm leading-6 [&>*:nth-last-child(-n+2)]:border-b-0">
      {entries.map((entry, index) => (
        <Fragment key={`${entry.key}-${index}`}>
          <dt className="max-w-48 border-b bg-muted/50 px-3 py-2 font-medium break-words text-muted-foreground">{entry.key}</dt>
          <dd className="m-0 flex min-w-0 items-start gap-2 border-b py-2 pr-1.5 pl-3 break-words [&_dl]:mb-0">
            <div className="min-w-0 flex-1">
              <FrontmatterValueView value={entry.value} />
            </div>
            <CopyButton
              text={frontmatterValueText(entry.value)}
              label={`Copy ${entry.key}`}
              size="icon-sm"
              className="-my-1 size-7 shrink-0 text-muted-foreground hover:text-foreground"
            />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function FrontmatterValueView({ value }: { value: FrontmatterValue }) {
  if (value.kind === 'text') {
    return value.text ? <span className="whitespace-pre-wrap">{value.text}</span> : <span className="text-muted-foreground">—</span>;
  }
  if (value.kind === 'map') return <MarkdownFrontmatter entries={value.entries} />;
  if (value.items.every((item) => item.kind === 'text')) {
    return (
      <span className="flex flex-wrap gap-1.5">
        {value.items.map((item, index) => (
          <span key={index} className="rounded-md border bg-muted/50 px-2 py-0.5 text-xs">{item.kind === 'text' && item.text}</span>
        ))}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {value.items.map((item, index) => <FrontmatterValueView key={index} value={item} />)}
    </div>
  );
}
