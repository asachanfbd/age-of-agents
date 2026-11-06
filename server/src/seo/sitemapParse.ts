/** What the sitemap protocol allows in one file. */
export const MAX_SITEMAP_URLS = 50_000;
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

export interface SitemapEntry { loc: string; lastmod: string | null }

export interface ParsedSitemap {
  kind: 'urlset' | 'index';
  entries: SitemapEntry[];
  /** True when the file listed more entries than `maxEntries`; the rest were not read. */
  truncated: boolean;
}

/** A file that is not a usable sitemap; the message names the line for malformed XML. */
export class SitemapParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SitemapParseError';
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const localName = (qualified: string) => qualified.slice(qualified.indexOf(':') + 1);

function decodeEntities(text: string, fail: (message: string) => never): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (_m, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) fail(`invalid character reference &${body};`);
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body];
    if (named === undefined) fail(`undefined entity &${body};`);
    return named;
  });
}

/**
 * Reads a sitemap (`urlset`) or sitemap index (`sitemapindex`). A purpose-built reader rather than a general XML library:
 * it refuses any DOCTYPE or ENTITY declaration (so entity-expansion attacks cannot start), accepts namespace prefixes, CDATA
 * and a byte-order mark, checks that tags nest correctly, and stops after `maxEntries` entries.
 */
export function parseSitemap(xml: string, maxEntries = MAX_SITEMAP_URLS): ParsedSitemap {
  const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const lineAt = (index: number) => text.slice(0, index).split('\n').length;
  const failAt = (index: number, message: string): never => { throw new SitemapParseError(`Malformed XML at line ${lineAt(index)}: ${message}`); };

  const stack: string[] = [];
  const entries: SitemapEntry[] = [];
  let kind: ParsedSitemap['kind'] | null = null;
  let rootClosed = false;
  let current: { loc: string; lastmod: string | null } | null = null;
  let field: 'loc' | 'lastmod' | null = null;
  let buffer = '';
  let i = 0;

  const addText = (raw: string, at: number, cdata: boolean) => {
    if (!stack.length) {
      if (raw.trim()) failAt(at, 'text outside the root element');
      return;
    }
    if (field) buffer += cdata ? raw : decodeEntities(raw, (m) => failAt(at, m));
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) { addText(text.slice(i), i, false); break; }
    if (lt > i) addText(text.slice(i, lt), i, false);
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) failAt(lt, 'unterminated comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) failAt(lt, 'unterminated CDATA section');
      addText(text.slice(lt + 9, end), lt, true);
      i = end + 3;
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) failAt(lt, 'unterminated processing instruction');
      i = end + 2;
    } else if (text.startsWith('<!', lt)) {
      failAt(lt, /^<!(DOCTYPE|ENTITY)/i.test(text.slice(lt, lt + 10)) ? 'DOCTYPE and ENTITY declarations are not allowed' : 'unexpected markup declaration');
    } else if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt);
      if (end === -1) failAt(lt, 'unterminated closing tag');
      const name = localName(text.slice(lt + 2, end).trim());
      if (stack.pop() !== name) failAt(lt, `unexpected closing tag </${name}>`);
      if (field && name === field) { if (current) { if (field === 'loc') current.loc = buffer.trim(); else current.lastmod = buffer.trim() || null; } field = null; buffer = ''; }
      if ((name === 'url' || name === 'sitemap') && current && stack.length === 1) {
        if (current.loc) {
          if (entries.length >= maxEntries) return { kind: kind!, entries, truncated: true };
          entries.push({ loc: current.loc, lastmod: current.lastmod });
        }
        current = null;
      }
      if (!stack.length) rootClosed = true;
      i = end + 1;
    } else {
      if (rootClosed) failAt(lt, 'content after the root element');
      let end = lt + 1;
      let quote = '';
      for (; end < text.length; end++) {
        const c = text[end]!;
        if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
      }
      if (end >= text.length) failAt(lt, 'unterminated tag');
      const inner = text.slice(lt + 1, end);
      const selfClosing = inner.endsWith('/');
      const name = localName(inner.replace(/\/$/, '').split(/\s/)[0]!);
      if (!name) failAt(lt, 'empty tag name');
      if (!stack.length) {
        if (name === 'urlset') kind = 'urlset';
        else if (name === 'sitemapindex') kind = 'index';
        else throw new SitemapParseError(`This is not a sitemap: the root element is <${name}>`);
      } else if (stack.length === 1 && ((kind === 'urlset' && name === 'url') || (kind === 'index' && name === 'sitemap'))) {
        current = { loc: '', lastmod: null };
      } else if (current && stack.length === 2 && (name === 'loc' || name === 'lastmod')) {
        field = name;
        buffer = '';
      }
      if (selfClosing) {
        if (field && name === field) { field = null; buffer = ''; }
        if (!stack.length) rootClosed = true;
      } else stack.push(name);
      i = end + 1;
    }
  }
  if (stack.length) throw new SitemapParseError(`Malformed XML at line ${lineAt(text.length)}: <${stack[stack.length - 1]}> is never closed`);
  if (!kind) throw new SitemapParseError('This is not a sitemap: the file is empty');
  return { kind, entries, truncated: false };
}

/** The `Sitemap:` lines of a robots.txt, as written (case-insensitive field name, comments and CRLF tolerated). Relative values are returned separately so they can be reported. */
export function parseRobotsSitemaps(robots: string): { urls: string[]; ignored: string[] } {
  const urls: string[] = [];
  const ignored: string[] = [];
  const text = robots.charCodeAt(0) === 0xfeff ? robots.slice(1) : robots;
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^sitemap\s*:\s*(\S+)$/i.exec(line);
    if (!m) continue;
    if (/^https?:\/\//i.test(m[1]!)) urls.push(m[1]!); else ignored.push(m[1]!);
  }
  return { urls, ignored };
}
