import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitFrontmatter } from '../lib/markdownFrontmatter';
import { MarkdownFrontmatter } from './MarkdownFrontmatter';

/**
 * Shared markdown renderer for agent/document content — used by chat bubbles (`web/src/ui/chat/*`)
 * and by the project popup's Documents viewer alike (which passes its own `className`), so it lives at this top level
 * rather than under `chat/`. The `.markdown-document` wrapper class supplies prose styling
 * (headings/code/tables/etc.) from `index.css`, which already resolves through theme-correct
 * `var(--text)`/`var(--text-dim)` custom properties under both `:root` and `.dark`.
 * A leading YAML frontmatter block is lifted out and shown as a key/value table above the body.
 */
export function MarkdownDocument({ content, className = 'markdown-document' }: { content: string; className?: string }) {
  const { frontmatter, body } = splitFrontmatter(content);
  return (
    <div className={className}>
      {frontmatter && <MarkdownFrontmatter entries={frontmatter} />}
      <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
    </div>
  );
}
