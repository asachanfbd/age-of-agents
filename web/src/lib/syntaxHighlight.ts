import Prism from 'prismjs';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-c.js';
import 'prismjs/components/prism-cpp.js';
import 'prismjs/components/prism-csharp.js';
import 'prismjs/components/prism-css.js';
import 'prismjs/components/prism-diff.js';
import 'prismjs/components/prism-docker.js';
import 'prismjs/components/prism-git.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-graphql.js';
import 'prismjs/components/prism-ini.js';
import 'prismjs/components/prism-java.js';
import 'prismjs/components/prism-javascript.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-markdown.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-ruby.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-scss.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-toml.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-yaml.js';

const EXTENSION_LANGUAGES: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  diff: 'diff',
  Dockerfile: 'docker',
  go: 'go',
  gql: 'graphql',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  htm: 'markup',
  html: 'markup',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  json5: 'json',
  jsx: 'jsx',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sass: 'scss',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svelte: 'markup',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'markup',
  xml: 'markup',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

const FILE_LANGUAGES: Record<string, string> = {
  '.dockerignore': 'git',
  '.env': 'bash',
  '.gitattributes': 'git',
  '.gitignore': 'git',
  Dockerfile: 'docker',
  Makefile: 'bash',
};

export function languageForPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? path;
  if (FILE_LANGUAGES[name]) return FILE_LANGUAGES[name];
  const extension = name.includes('.') ? name.split('.').pop() ?? '' : name;
  return EXTENSION_LANGUAGES[extension];
}

function escapeHtml(content: string) {
  return content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Prism returns one HTML string, while the viewer needs one element per source line for its
 * number gutter. Keep token spans balanced across line breaks so multi-line comments and strings
 * retain their highlighting without sacrificing wrapping or line numbers.
 */
export function highlightedLines(content: string, language?: string): string[] {
  const grammar = language ? Prism.languages[language] : undefined;
  const highlighted = grammar ? Prism.highlight(content, grammar, language ?? 'plain') : escapeHtml(content);
  const lines = [''];
  const openSpans: string[] = [];

  for (const part of highlighted.split(/(<span\b[^>]*>|<\/span>|\r?\n)/g)) {
    if (!part) continue;
    if (part === '\n' || part === '\r\n') {
      lines[lines.length - 1] += '</span>'.repeat(openSpans.length);
      lines.push(openSpans.join(''));
    } else {
      lines[lines.length - 1] += part;
      if (part.startsWith('<span')) openSpans.push(part);
      else if (part === '</span>') openSpans.pop();
    }
  }

  return lines;
}
