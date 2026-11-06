#!/usr/bin/env node

// A minimal stdio MCP server for an Agent Visual OS Content Studio writing session — see
// src/terminal/studioSessionTool.ts. It serves the tools named in $AGENT_VISUAL_OS_STUDIO_TOOLS.

import { createDaemonRelay, serveMcp } from './lib/mcp-stdio.mjs';

const daemon = createDaemonRelay({
  urlEnv: 'AGENT_VISUAL_OS_STUDIO_URL',
  notConnected: 'This session is not connected to Agent Visual OS, so its tools are unavailable.',
  timeoutMs: 15_000,
});

const query = (args) => {
  const params = new URLSearchParams();
  for (const key of ['platform', 'format', 'result', 'limit']) if (args?.[key] !== undefined) params.set(key, String(args[key]));
  const text = params.toString();
  return text ? `?${text}` : '';
};

const ALL_TOOLS = [
  {
    name: 'save_draft',
    description: 'Save a complete draft so it appears in the owner\'s result pane. It must fit the limits in your instructions (a post follows its platform\'s rules; the script is 1 to 50,000 characters); a draft over a limit is refused with a message naming it. Every complete draft must be saved with this tool; each call stores a new version and the newest wins.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The full draft text.' } },
      required: ['text'],
      additionalProperties: false,
    },
    call: (args) => daemon('POST', '/draft', { text: args?.text }, (draft) => `Draft saved (version ${draft.version}).`),
  },
  {
    name: 'get_concept',
    description: 'Get this Concept: its title, brief, posts and the state of its assets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => daemon('GET', '/concept', undefined, (concept) => JSON.stringify(concept, null, 2)),
  },
  {
    name: 'get_performance',
    description: 'Get published posts with their latest stats, engagement rate, results against the platform targets, text, hook and script excerpt, newest published first. Use it to see what worked before you propose anything. All filters are optional.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['linkedin', 'instagram', 'x', 'facebook', 'blog'] },
        format: { type: 'string', enum: ['text', 'image', 'carousel', 'video', 'reel', 'article'] },
        result: { type: 'string', enum: ['on-target', 'partly', 'below-target', 'too-early', 'no-target'], description: 'The overall result against the targets.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
      },
      additionalProperties: false,
    },
    call: (args) => daemon('GET', `/performance${query(args)}`, undefined, (r) => JSON.stringify(r.posts, null, 2)),
  },
  {
    name: 'get_reference_content',
    description: "Get the owner's imported Concepts: their earlier work from outside this system, newest published first, with title, brief, script, full post texts, live URL, published date, latest stats and results. Read them for voice, structure, hooks and length; never copy them. With a filter, each Concept lists only its matching posts.",
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['linkedin', 'instagram', 'x', 'facebook', 'blog'] },
        format: { type: 'string', enum: ['text', 'image', 'carousel', 'video', 'reel', 'article'] },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Concepts to return. Default 10.' },
      },
      additionalProperties: false,
    },
    call: (args) => daemon('GET', `/reference-content${query(args)}`, undefined, (r) => JSON.stringify(r.concepts, null, 2)),
  },
  {
    name: 'save_imported_concept',
    description: 'Save one past Concept as imported and published, with all its posts. All or nothing: a refused field (named like posts[1].text) saves nothing, so fix it or ask the owner and call again. Only call this after the owner agreed to the list you showed them.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '1 to 200 characters.' },
        brief: { type: 'string', description: 'Up to 5,000 characters.' },
        script: { type: 'string', description: 'The spoken script, 1 to 50,000 characters.' },
        posts: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object',
            properties: {
              platform: { type: 'string', enum: ['linkedin', 'instagram', 'x', 'facebook', 'blog'] },
              format: { type: 'string', enum: ['text', 'image', 'carousel', 'video', 'reel', 'article'] },
              text: { type: 'string', description: "The post text or caption, within the platform's limits." },
              publishedAt: { type: 'string', description: 'ISO instant with Z or an offset; not in the future.' },
              scheduledAt: { type: 'string', description: 'ISO instant with Z or an offset. Each of the two times defaults to the other.' },
              liveUrl: { type: 'string', description: 'http or https, up to 2,000 characters.' },
              note: { type: 'string', description: 'Up to 1,000 characters.' },
              externalAssets: { type: 'string', description: 'Up to 2,000 characters: images or video that exist elsewhere.' },
              stats: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    capturedAt: { type: 'string', description: 'ISO instant, not before publishedAt.' },
                    counts: { type: 'object', description: 'Whole numbers; impressions, reach, views, likes, comments, shares, saves, linkClicks, profileVisits, followersGained. Leave out what is unknown; never guess 0.' },
                    watchTime: { type: 'number', description: 'Average seconds, video and reel posts only.' },
                    note: { type: 'string', description: 'Up to 1,000 characters.' },
                  },
                  required: ['capturedAt', 'counts'],
                  additionalProperties: false,
                },
              },
            },
            required: ['platform', 'format'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'posts'],
      additionalProperties: false,
    },
    call: (args) => daemon('POST', '/imported-concept', args ?? {}, (r) => `Saved "${r.title}" as imported (${r.posts.length} ${r.posts.length === 1 ? 'post' : 'posts'}).`),
  },
  {
    name: 'set_checklist',
    description: 'Publish the media you need before building the video (1 to 30 items). The owner provides each file and ticks the item (provided, or not needed), then confirms. Calling it again before confirmation replaces the list and keeps the ticks of items whose id stayed.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array', minItems: 1, maxItems: 30,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '1 to 40 characters of a-z, 0-9 and -, unique in the list.' },
              label: { type: 'string', description: 'One line, 1 to 200 characters.' },
              detail: { type: 'string', description: 'Optional, up to 1,000 characters: format, length, orientation.' },
            },
            required: ['id', 'label'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    call: (args) => daemon('POST', '/checklist', { items: args?.items }, (list) => `Checklist published (${list.items.length} items). Wait for the owner to confirm the assets before building the video.`),
  },
  {
    name: 'report_speaking_rate',
    description: "Record how fast the owner speaks in one of their facecam clips or voice-overs: the number of spoken words you counted and the duration of the speech in seconds. Call it once per file; a second call for the same file replaces the first. The average of all recordings becomes the speaking speed the Script tab uses to estimate video length. It does not change the checklist.",
    inputSchema: {
      type: 'object',
      properties: {
        mediaId: { type: 'string', description: 'The id of the video or audio file, from list_media.' },
        words: { type: 'integer', minimum: 5, description: 'Spoken words counted in the file.' },
        durationSeconds: { type: 'number', minimum: 3, maximum: 7200, description: 'Length of the file in seconds.' },
      },
      required: ['mediaId', 'words', 'durationSeconds'],
      additionalProperties: false,
    },
    call: (args) => daemon('POST', '/speaking-rate', { mediaId: args?.mediaId, words: args?.words, durationSeconds: args?.durationSeconds }, (r) => `Recorded ${Math.round(r.wordsPerMinute)} words per minute. The Building's speaking speed is now ${r.speakingSpeed.speakingWpm} wpm (${r.speakingSpeed.source}).`),
  },
  {
    name: 'list_media',
    description: "List the owner's media files for this Concept: name, kind, size, duration, dimensions, the path for staticFile() and the checklist items each is linked to.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => daemon('GET', '/media', undefined, (media) => JSON.stringify(media, null, 2)),
  },
  {
    name: 'render_images',
    description: "Render this post's still compositions to PNG, in the order given; the owner sees them in the gallery. Each call replaces this round's images. Returns when every image is rendered (it may first wait for another render in this Building), or the error naming the image that failed.",
    inputSchema: {
      type: 'object',
      properties: {
        compositionIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: "This post's still composition ids, in image order." },
        width: { type: 'integer', minimum: 320, maximum: 4000, description: "Defaults to the post's size." },
        height: { type: 'integer', minimum: 320, maximum: 4000, description: "Defaults to the post's size." },
      },
      required: ['compositionIds'],
      additionalProperties: false,
    },
    // A call may wait in the queue behind a video render, then take up to 5 minutes.
    call: (args) => daemon('POST', '/images', { compositionIds: args?.compositionIds, width: args?.width, height: args?.height }, (r) => `Rendered ${r.images.length} ${r.images.length === 1 ? 'image' : 'images'} (round ${r.round}, ${r.images[0]?.width}x${r.images[0]?.height}). They are in the owner's gallery.`, { timeoutMs: 62 * 60_000 }),
  },
  {
    name: 'render_thumbnails',
    description: "Render this Concept's thumbnail stills to PNG, one per variant, in the order given; the owner sees them and picks the final one. Each call replaces this round's thumbnails. Returns when every thumbnail is rendered (it may first wait for another render in this Building), or the error naming the thumbnail that failed.",
    inputSchema: {
      type: 'object',
      properties: {
        compositionIds: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' }, description: "This Concept's thumbnail still ids, one per variant." },
        width: { type: 'integer', minimum: 320, maximum: 4000, description: 'Defaults to 1280.' },
        height: { type: 'integer', minimum: 320, maximum: 4000, description: 'Defaults to 720.' },
      },
      required: ['compositionIds'],
      additionalProperties: false,
    },
    // A call may wait in the queue behind a video render, then take up to 5 minutes.
    call: (args) => daemon('POST', '/thumbnails', { compositionIds: args?.compositionIds, width: args?.width, height: args?.height }, (r) => `Rendered ${r.thumbnails.length} ${r.thumbnails.length === 1 ? 'thumbnail' : 'thumbnails'} (round ${r.round}, ${r.thumbnails[0]?.width}x${r.thumbnails[0]?.height}). The owner picks the final one.`, { timeoutMs: 62 * 60_000 }),
  },
];

const enabled = new Set((process.env.AGENT_VISUAL_OS_STUDIO_TOOLS ?? '').split(',').filter(Boolean));
await serveMcp({ name: 'agent-visual-os-studio', version: '1.0.0' }, ALL_TOOLS.filter((tool) => enabled.has(tool.name)));
