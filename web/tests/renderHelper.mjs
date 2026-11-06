import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { rolldown } from 'rolldown';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const CACHE = `${WEB}node_modules/.cache/render-tests`;
const EXTERNAL = [/^react/, /^lucide-react/, /^@radix-ui/, /^class-variance-authority/, /^clsx/, /^tailwind-merge/, /^sonner/, /^zustand/, /^cmdk/];
const loaded = new Map();

/** Bundles one TSX module (with its `@/` imports) and loads it, so a component can be rendered to markup in plain Node, with no DOM. */
export async function loadModule(entry) {
  if (loaded.has(entry)) return loaded.get(entry);
  const bundle = await rolldown({ input: `${WEB}${entry}`, platform: 'node', external: EXTERNAL, resolve: { alias: { '@': `${WEB}src` }, extensions: ['.tsx', '.ts', '.js'] }, transform: { jsx: { runtime: 'automatic' } }, logLevel: 'silent' });
  const { output } = await bundle.generate({ format: 'esm' });
  mkdirSync(CACHE, { recursive: true });
  const file = `${CACHE}/${createHash('sha1').update(entry).digest('hex').slice(0, 12)}.mjs`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, output[0].code);
  const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
  loaded.set(entry, mod);
  return mod;
}

/** Markup of `<Component {...props} />` exported by the module at `entry`. */
export async function render(entry, exportName, props = {}) {
  const mod = await loadModule(entry);
  return renderToStaticMarkup(createElement(mod[exportName], props));
}
