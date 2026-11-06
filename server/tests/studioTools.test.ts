import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { studioSystemPrompt, resumeContext } from '../src/content/studioInstructions.ts';
import { parseDraftText } from '../src/content/studioDrafts.ts';
import { STUDIO_TABS, studioTabFor } from '../src/content/studioTabs.ts';
import { defaultWritingSkillFile, parseWritingSkillFile, readWritingSkill } from '../src/content/writingSkill.ts';
import { studioMcpServer } from '../src/terminal/studioSessionTool.ts';

const concept = { title: 'T', brief: '', posts: [] };

test('U07/U09/U10 the script instructions give the job, the knowledge paths and the save rule', () => {
  const prompt = studioSystemPrompt({ tab: STUDIO_TABS.script!, concept, buildingDir: '/b', skillText: null });
  assert.match(prompt, /spoken script for a short-form video/);
  assert.match(prompt, /length, the hook or the call to action/);
  assert.match(prompt, /\/b\/knowledge/);
  assert.match(prompt, /new fact[\s\S]*say in the chat/);
  assert.match(prompt, /General section and its "Video script" section/);
  assert.match(prompt, /Every complete draft must be saved with the `save_draft` tool/);
  assert.match(prompt, /\(none\)/);
  assert.match(prompt, /\(none yet\)/);
  assert.equal(prompt.includes('Starting point'), false);
  assert.equal(prompt.includes('## Writing skill'), false);
  assert.match(resumeContext('abc'), /latest saved draft was:\n\nabc/);
});

test('U22 the tab registry names the tools and the tool server serves only those', () => {
  assert.deepEqual([...STUDIO_TABS.script!.tools], ['save_draft', 'get_concept', 'get_performance', 'get_reference_content']);
  assert.equal(studioTabFor('script'), STUDIO_TABS.script);
  assert.equal(studioTabFor('video'), STUDIO_TABS.video);
  assert.equal(studioTabFor('post-text'), undefined);
  assert.equal(studioMcpServer('v', STUDIO_TABS.video!).env.AGENT_VISUAL_OS_STUDIO_TOOLS, 'get_concept,get_performance,get_reference_content,set_checklist,report_speaking_rate,list_media');
  const server = studioMcpServer('sid', STUDIO_TABS.script!);
  assert.deepEqual(server.tools, ['save_draft', 'get_concept', 'get_performance', 'get_reference_content']);
  assert.equal(server.env.AGENT_VISUAL_OS_TASK_ID, 'sid');
  assert.equal(server.env.AGENT_VISUAL_OS_STUDIO_TOOLS, 'save_draft,get_concept,get_performance,get_reference_content');
  assert.ok(server.env.AGENT_VISUAL_OS_HOOK_TOKEN);
});

test('U04/U05 parseDraftText refuses empty and non-text input and trims', () => {
  for (const bad of ['', ' \n  ', undefined, null, 3, ['x']]) assert.throws(() => parseDraftText(bad), { status: 400 });
  assert.equal(parseDraftText('  hi  '), 'hi');
});

test('U13 the default skill path is under the given home folder', () => {
  assert.equal(defaultWritingSkillFile('/h'), path.join('/h', '.claude', 'skills', 'human-content-writing-skill', 'SKILL.md'));
});

test('U12 readWritingSkill returns null for a missing file or a folder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'skill-'));
  try {
    assert.equal(await readWritingSkill(path.join(dir, 'none.md')), null);
    assert.equal(await readWritingSkill(dir), null);
    await writeFile(path.join(dir, 's.md'), 'text é');
    assert.equal(await readWritingSkill(path.join(dir, 's.md')), 'text é');
    assert.equal(await parseWritingSkillFile(path.join(dir, 's.md')), path.join(dir, 's.md'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('I20 the stdio tool server lists exactly the enabled tools and relays them with the token and the session id', async () => {
  const seen: { method?: string; url?: string; auth?: string; body: string; agent?: string }[] = [];
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, agent: req.headers['user-agent'] });
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/imported-concept') && JSON.parse(body).title === 'refuse') { res.statusCode = 400; res.end(JSON.stringify({ error: 'posts: posts must be a list of 1 to 20', field: 'posts' })); return; }
      if (req.url?.includes('/imported-concept')) { res.end(JSON.stringify({ conceptId: 'c1', title: 'Past', posts: [{ postId: 'p1' }] })); return; }
      if (req.url?.includes('/reference-content')) { res.end(JSON.stringify({ concepts: [{ title: 'Older' }] })); return; }
      const reply = req.url?.includes('/draft') ? { version: 7 } : req.url?.includes('/checklist') ? { items: [{}, {}] } : req.url?.includes('/media') ? { media: [] } : req.url?.includes('/images') ? { round: 2, images: [{ width: 1080, height: 1350 }, { width: 1080, height: 1350 }] } : req.url?.includes('/thumbnails') ? { round: 1, thumbnails: [1, 2, 3].map(() => ({ width: 1280, height: 720 })) } : { id: 'c1' };
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const port = (http.address() as { port: number }).port;
  const run = (tools: string) => spawn(process.execPath, [path.resolve('bin/studio-session-mcp.mjs')], {
    env: { ...process.env, AGENT_VISUAL_OS_TASK_ID: 'sess', AGENT_VISUAL_OS_HOOK_TOKEN: 'tok', AGENT_VISUAL_OS_STUDIO_URL: `http://127.0.0.1:${port}/api/studio-session`, AGENT_VISUAL_OS_STUDIO_TOOLS: tools },
  });
  const talk = async (tools: string, requests: object[]): Promise<any[]> => {
    const child = run(tools);
    const lines = createInterface({ input: child.stdout });
    const replies: any[] = [];
    const done = new Promise<void>((resolve) => lines.on('line', (l) => { replies.push(JSON.parse(l)); if (replies.length === requests.length) resolve(); }));
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    await done;
    child.kill();
    return replies;
  };
  try {
    const [list] = await talk('save_draft,get_concept', [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    assert.deepEqual(list.result.tools.map((x: { name: string }) => x.name), ['save_draft', 'get_concept']);
    const [only] = await talk('get_concept', [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    assert.deepEqual(only.result.tools.map((x: { name: string }) => x.name), ['get_concept']);
    const replies = await talk('save_draft,get_concept', [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_draft', arguments: { text: 'hello' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_concept', arguments: {} } },
    ]);
    assert.match(replies[0].result.content[0].text, /Draft saved \(version 7\)/);
    assert.match(replies[1].result.content[0].text, /"id": "c1"/);
    assert.deepEqual(seen.map((s) => [s.method, s.url, s.auth]), [['POST', '/api/studio-session/draft?taskId=sess', 'Bearer tok'], ['GET', '/api/studio-session/concept?taskId=sess', 'Bearer tok']]);
    assert.deepEqual(JSON.parse(seen[0]!.body), { text: 'hello' });
    const videoTools = 'get_concept,set_checklist,list_media';
    const [videoList] = await talk(videoTools, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    assert.deepEqual(videoList.result.tools.map((x: { name: string }) => x.name), ['get_concept', 'set_checklist', 'list_media']);
    seen.length = 0;
    const video = await talk(videoTools, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_checklist', arguments: { items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_media', arguments: {} } },
    ]);
    assert.match(video[0].result.content[0].text, /Checklist published \(2 items\)/);
    assert.match(video[1].result.content[0].text, /"media"/);
    assert.deepEqual(seen.map((x) => [x.method, x.url]).sort(), [['GET', '/api/studio-session/media?taskId=sess'], ['POST', '/api/studio-session/checklist?taskId=sess']]);
    // The video tools are quick, so they use fetch.
    assert.deepEqual(seen.map((x) => [x.url!.split('?')[0], x.agent === undefined ? 'node:http' : 'fetch']).sort(), [['/api/studio-session/checklist', 'fetch'], ['/api/studio-session/media', 'fetch']]);
    // U21 (32.006): render_images is in the schema and relays over node:http.
    const imageTools = 'get_concept,save_draft,list_media,render_images';
    const [imageList] = await talk(imageTools, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    const schema = imageList.result.tools.find((x: { name: string }) => x.name === 'render_images');
    assert.deepEqual(schema.inputSchema.required, ['compositionIds']);
    assert.deepEqual([schema.inputSchema.properties.compositionIds.maxItems, schema.inputSchema.properties.width.minimum, schema.inputSchema.properties.height.maximum], [20, 320, 4000]);
    seen.length = 0;
    const [rendered] = await talk(imageTools, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'render_images', arguments: { compositionIds: ['still-a-one', 'still-a-two'], width: 1080 } } }]);
    assert.match(rendered.result.content[0].text, /Rendered 2 images \(round 2, 1080x1350\)/);
    assert.deepEqual(seen.map((x) => [x.method, x.url, x.agent === undefined ? 'node:http' : 'fetch']), [['POST', '/api/studio-session/images?taskId=sess', 'node:http']]);
    assert.deepEqual(JSON.parse(seen[0]!.body), { compositionIds: ['still-a-one', 'still-a-two'], width: 1080 });
    // I61 (37.009): each tab lists get_reference_content, the import session its two tools; filters, the save body and refusals are relayed.
    const [importList] = await talk('save_imported_concept,get_reference_content', [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    assert.deepEqual(importList.result.tools.map((x: { name: string }) => x.name), ['get_reference_content', 'save_imported_concept']);
    const refSchema = importList.result.tools.find((x: { name: string }) => x.name === 'get_reference_content').inputSchema;
    assert.deepEqual([refSchema.properties.limit.minimum, refSchema.properties.limit.maximum], [1, 50]);
    assert.equal(importList.result.tools.find((x: { name: string }) => x.name === 'save_imported_concept').inputSchema.properties.posts.maxItems, 20);
    seen.length = 0;
    const save = { title: 'Past', posts: [{ platform: 'x', format: 'text' }] };
    const importReplies = await talk('save_imported_concept,get_reference_content', [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_reference_content', arguments: { platform: 'x', format: 'text', limit: 5 } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'save_imported_concept', arguments: save } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'save_imported_concept', arguments: { title: 'refuse' } } },
    ]);
    assert.deepEqual(seen.map((x) => [x.method, x.url]).sort(), [['GET', '/api/studio-session/reference-content?platform=x&format=text&limit=5&taskId=sess'], ['POST', '/api/studio-session/imported-concept?taskId=sess'], ['POST', '/api/studio-session/imported-concept?taskId=sess']]);
    const byId = Object.fromEntries(importReplies.map((r) => [r.id, r.result]));
    assert.match(byId[1].content[0].text, /"title": "Older"/);
    assert.match(byId[2].content[0].text, /Saved "Past" as imported \(1 post\)/);
    assert.equal(byId[3].isError, true);
    assert.match(byId[3].content[0].text, /Failed: posts: posts must be a list/);
    // TI43: render_thumbnails is offered only to the thumbnail tab and relays over node:http.
    assert.ok(!imageList.result.tools.some((x: { name: string }) => x.name === 'render_thumbnails'));
    const thumbTools = 'get_concept,get_performance,save_draft,list_media,render_thumbnails';
    const [thumbList] = await talk(thumbTools, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    const thumbSchema = thumbList.result.tools.find((x: { name: string }) => x.name === 'render_thumbnails');
    assert.deepEqual(thumbSchema.inputSchema.required, ['compositionIds']);
    assert.deepEqual([thumbSchema.inputSchema.properties.compositionIds.maxItems, thumbSchema.inputSchema.properties.width.minimum, thumbSchema.inputSchema.properties.height.maximum], [5, 320, 4000]);
    assert.ok(!thumbList.result.tools.some((x: { name: string }) => x.name === 'render_images'));
    seen.length = 0;
    const [thumbs] = await talk(thumbTools, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'render_thumbnails', arguments: { compositionIds: ['thumb-a-x', 'thumb-a-y', 'thumb-a-z'], width: 1280, height: 720 } } }]);
    assert.match(thumbs.result.content[0].text, /Rendered 3 thumbnails \(round 1, 1280x720\)/);
    assert.deepEqual(seen.map((x) => [x.method, x.url, x.agent === undefined ? 'node:http' : 'fetch']), [['POST', '/api/studio-session/thumbnails?taskId=sess', 'node:http']]);
    assert.deepEqual(JSON.parse(seen[0]!.body), { compositionIds: ['thumb-a-x', 'thumb-a-y', 'thumb-a-z'], width: 1280, height: 720 });
  } finally { http.close(); }
});

test('the long-call transport: success, the daemon\'s error text, an unreachable daemon, and its own timeout', async () => {
  const relayModule: string = '../bin/lib/mcp-stdio.mjs';
  const { requestDaemon, requestDaemonLong, FETCH_SAFE_MS } = await import(relayModule);
  assert.ok(FETCH_SAFE_MS < 300_000);
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/slow') return;
      res.statusCode = req.url === '/bad' ? 409 : req.url === '/garbled' ? 500 : 200;
      res.end(req.url === '/garbled' ? '<html>' : JSON.stringify(req.url === '/bad' ? { error: 'Waiting for the owner to confirm assets' } : { echo: JSON.parse(body || '{}'), auth: req.headers.authorization }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.AGENT_VISUAL_OS_HOOK_TOKEN = 'tok';
  try {
    assert.deepEqual(await requestDaemonLong('POST', `${base}/ok`, { a: 1 }, 5_000), { body: { echo: { a: 1 }, auth: 'Bearer tok' } });
    assert.deepEqual(await requestDaemon('POST', `${base}/ok`, { a: 2 }, FETCH_SAFE_MS + 1), { body: { echo: { a: 2 }, auth: 'Bearer tok' } });
    assert.match((await requestDaemonLong('POST', `${base}/bad`, {}, 5_000)).error.content[0].text, /Failed: Waiting for the owner/);
    assert.match((await requestDaemonLong('GET', `${base}/garbled`, undefined, 5_000)).error.content[0].text, /Failed: HTTP 500/);
    assert.match((await requestDaemonLong('GET', `${base}/slow`, undefined, 50)).error.content[0].text, /^Failed: /);
  } finally {
    server.closeAllConnections();
    server.close();
  }
  assert.match((await requestDaemonLong('GET', `${base}/ok`, undefined, 1_000)).error.content[0].text, /^Failed: /);
});
