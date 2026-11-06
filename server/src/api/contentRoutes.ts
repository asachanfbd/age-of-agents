import express from 'express';
import type { Request, RequestHandler, Response, Router } from 'express';
import { normalizeProject } from '../buildings/normalize.ts';
import { projectsDb } from '../db/collections.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { getProject, ProjectNotFoundError } from '../projects/projectService.ts';
import { addBrandFile, deleteBrandFile, listBrandFiles, readBrandFile } from '../content/brandFiles.ts';
import { calendar } from '../content/calendar.ts';
import { createConcept, createPost, deleteConcept, deletePost, finalizePost, getConcept, isRecordId, listConcepts, patchConcept, patchPost, unfinalizePost } from '../content/concepts.ts';
import type { ContentCtx } from '../content/context.ts';
import { ContentConflictError, ContentInputError, ContentNotFoundError } from '../content/errors.ts';
import { createSection, deleteSection, listSections, putColours, putSection, readColours, readSection } from '../content/knowledge.ts';
import { FILE_BODY_WINDOW, EXTRACT_BODY_WINDOW } from '../content/limits.ts';
import { parseUpload } from '../content/extractions.ts';
import type { ExtractionDeps } from '../content/extractions.ts';
import { editPublishDetails, publishPost, unpublishPost } from '../content/publish.ts';
import { postImage, postImagesZip, postMedia, postThumbnail, postVideo } from '../content/postMedia.ts';
import { createStat, deleteStat, publishedPost, discardStatExtraction, extractStats, listStats, patchStat, statSource } from '../content/snapshots.ts';
import { contentCtx } from '../content/runtime.ts';
import { settingsView, updateSettings } from '../content/settings.ts';
import { clearManualSpeakingWpm, deleteSpeakingRateSample, speakingRateSamples, speakingSpeed } from '../content/speakingSpeed.ts';
import { pendingProposals, retroLog } from '../content/retroStore.ts';
import { putStyle, readStyle, styleHistory } from '../content/style.ts';
import type { StudioSessions } from '../content/studioSessions.ts';
import type { Insights } from '../content/insights.ts';
import { parsePlatformParam, putTargets, readAllTargets, evaluationDays, targetHistory } from '../content/targets.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;
type ParamReader = (req: Request, name: string) => string;

export interface ContentGuards {
  contentProject(req: Request): Promise<ProjectRecord>;
  recordId(req: Request, name: string): string;
  bodyOf(req: Request): unknown;
  refuseIfReadOnly(project: ProjectRecord): void;
}

/** The checks every Content Studio route shares: the Building is a Content Studio Building, ids are record ids, bodies are objects, writes are refused on a read-only Building. */
export function contentGuards(param: ParamReader): ContentGuards {
  return {
    async contentProject(req) {
      const project = await projectsDb.get(param(req, 'id'));
      if (!project) throw new ProjectNotFoundError();
      if (project.typeId !== 'content-studio') throw new ContentNotFoundError('This is not a Content Studio Building');
      return project;
    },
    recordId(req, name) {
      const v = param(req, name);
      if (!isRecordId(v)) throw new ContentNotFoundError('Not found');
      return v;
    },
    bodyOf(req) {
      const b = req.body as unknown;
      if (b !== undefined && (typeof b !== 'object' || b === null || Array.isArray(b))) throw new ContentInputError('The request body must be a JSON object');
      return b ?? {};
    },
    refuseIfReadOnly(project) {
      const view = normalizeProject(project);
      if (view.readOnly) throw new ContentConflictError(view.readOnlyReason ?? 'This Building is read-only.');
    },
  };
}

/** The Content Studio Building's API under `/projects/:id/content`. Every route 404s for a Building that is not a Content Studio Building; every write route answers 409 for a read-only one. */
export function mountContentRoutes(router: Router, route: RouteWrapper, param: ParamReader, studioSessions: StudioSessions, extraction: ExtractionDeps, insights: Insights, announceProject: (project: ProjectRecord) => void = () => undefined): void {
  const base = '/projects/:id/content';
  const { contentProject, recordId, bodyOf, refuseIfReadOnly } = contentGuards(param);

  const read = <T>(handler: (ctx: ContentCtx, req: Request, project: ProjectRecord) => T | Promise<T>): RequestHandler => route(async (req, res) => {
    const project = await contentProject(req);
    res.json(await handler(contentCtx(project), req, project));
  });
  /** A write: refused on a read-only Building, run one at a time per Building. */
  const write = <T>(handler: (ctx: ContentCtx, req: Request, body: any, project: ProjectRecord) => T | Promise<T>, status = 200): RequestHandler => route(async (req, res) => {
    const project = await contentProject(req);
    refuseIfReadOnly(project);
    const body = bodyOf(req);
    const ctx = contentCtx(project);
    const out = await ctx.exclusive(async () => handler(ctx, req, body, project));
    if (status === 204) { res.status(204).end(); return; }
    res.status(status).json(out);
  });

  const cid = (req: Request) => recordId(req, 'cid');
  const pid = (req: Request) => recordId(req, 'pid');

  // ---- concepts and posts --------------------------------------------------
  router.get(`${base}/concepts`, read((ctx, req) => listConcepts(ctx, req.query)));
  router.post(`${base}/concepts`, write((ctx, _r, b) => createConcept(ctx, b), 201));
  router.get(`${base}/concepts/:cid`, read((ctx, req) => getConcept(ctx, cid(req))));
  router.patch(`${base}/concepts/:cid`, write((ctx, req, b) => patchConcept(ctx, cid(req), b)));
  router.delete(`${base}/concepts/:cid`, write(async (ctx, req) => {
    await studioSessions.removeForConcept(ctx, cid(req));
    await deleteConcept(ctx, cid(req));
  }, 204));
  router.post(`${base}/concepts/:cid/posts`, write((ctx, req, b) => createPost(ctx, cid(req), b), 201));
  router.patch(`${base}/concepts/:cid/posts/:pid`, write((ctx, req, b) => patchPost(ctx, cid(req), pid(req), b)));
  router.delete(`${base}/concepts/:cid/posts/:pid`, write((ctx, req) => deletePost(ctx, cid(req), pid(req), (assetIds) => studioSessions.removeForPost(ctx, cid(req), pid(req), assetIds)), 204));
  router.post(`${base}/concepts/:cid/posts/:pid/finalize`, write((ctx, req) => finalizePost(ctx, cid(req), pid(req))));
  router.post(`${base}/concepts/:cid/posts/:pid/unfinalize`, write((ctx, req) => unfinalizePost(ctx, cid(req), pid(req))));
  // ---- publish and stats ---------------------------------------------------
  const post = `${base}/concepts/:cid/posts/:pid`;
  const sid = (req: Request) => recordId(req, 'statId');
  router.post(`${post}/publish`, write((ctx, req, b) => publishPost(ctx, cid(req), pid(req), b)));
  router.patch(`${post}/publish`, write((ctx, req, b) => { const post = editPublishDetails(ctx, cid(req), pid(req), b); insights.statsChanged(ctx); return post; }));
  router.post(`${post}/unpublish`, write((ctx, req) => { const post = unpublishPost(ctx, cid(req), pid(req)); insights.statsChanged(ctx); return post; }));
  router.get(`${post}/media`, read((ctx, req) => postMedia(ctx, cid(req), pid(req))));
  const file = (name: string, type: string, bytes: Buffer, res: Response, disposition: 'attachment' | 'inline' = 'attachment') => {
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.type(type).send(bytes);
  };
  router.get(`${post}/media/images.zip`, route(async (req, res) => {
    file('images.zip', 'application/zip', await postImagesZip(contentCtx(await contentProject(req)), cid(req), pid(req)), res);
  }));
  router.get(`${post}/media/images/:index`, route(async (req, res) => {
    const f = await postImage(contentCtx(await contentProject(req)), cid(req), pid(req), /^\d{1,3}$/.test(param(req, 'index')) ? Number(param(req, 'index')) : -1);
    file(f.name, f.type, f.bytes, res);
  }));
  router.get(`${post}/media/video`, route(async (req, res) => {
    const f = await postVideo(contentCtx(await contentProject(req)), cid(req), pid(req));
    file(f.name, f.type, f.bytes, res);
  }));
  router.get(`${post}/media/thumbnail`, route(async (req, res) => {
    const f = await postThumbnail(contentCtx(await contentProject(req)), cid(req), pid(req));
    file(f.name, f.type, f.bytes, res);
  }));
  router.get(`${post}/stats`, read((ctx, req) => listStats(ctx, cid(req), pid(req))));
  router.post(`${post}/stats`, write(async (ctx, req, b) => { const stat = await createStat(ctx, cid(req), pid(req), b); insights.statsChanged(ctx); return stat; }, 201));
  // `extractions` is registered before `:statId` so it is never read as an id.
  router.post(`${post}/stats/extractions`, express.raw({ type: () => true, limit: EXTRACT_BODY_WINDOW }), route(async (req, res) => {
    const project = await contentProject(req);
    refuseIfReadOnly(project);
    const ctx = contentCtx(project);
    publishedPost(ctx, cid(req), pid(req));
    const input = await parseUpload(req.headers['content-type'], Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    res.json(await extractStats(ctx, extraction, cid(req), pid(req), input));
  }));
  router.delete(`${post}/stats/extractions/:eid`, write((ctx, req) => discardStatExtraction(ctx, cid(req), pid(req), recordId(req, 'eid')), 204));
  router.patch(`${post}/stats/:statId`, write((ctx, req, b) => { const stat = patchStat(ctx, cid(req), pid(req), sid(req), b); insights.statsChanged(ctx); return stat; }));
  router.delete(`${post}/stats/:statId`, write(async (ctx, req) => { await deleteStat(ctx, cid(req), pid(req), sid(req)); insights.statsChanged(ctx); }, 204));
  router.get(`${post}/stats/:statId/sources/:sourceId`, route(async (req, res) => {
    const f = await statSource(contentCtx(await contentProject(req)), cid(req), pid(req), sid(req), recordId(req, 'sourceId'));
    file(f.name, f.contentType, f.bytes, res, 'inline');
  }));
  router.get(`${base}/calendar`, read((ctx, req) => calendar(ctx, req.query)));

  // ---- import session ------------------------------------------------------
  const { imports } = studioSessions;
  const importSession = `${base}/import-session`;
  router.get(importSession, read((ctx) => imports.get(ctx)));
  router.post(importSession, write((ctx) => imports.start(ctx), 201));
  router.post(`${importSession}/resume`, write((ctx) => imports.resume(ctx)));
  router.post(`${importSession}/new`, write((ctx) => imports.startNew(ctx), 201));
  router.post(`${importSession}/end`, write((ctx) => imports.end(ctx)));

  // ---- settings ------------------------------------------------------------
  router.get(`${base}/settings`, read((ctx, _r, project) => settingsView(ctx, project)));
  router.patch(`${base}/settings`, write(async (ctx, _r, b, project) => {
    const before = evaluationDays(ctx);
    const view = await updateSettings(ctx, project, b);
    if (view.name !== project.name) announceProject(await getProject(project.id));
    if (view.evaluationDays !== before) insights.statsChanged(ctx);
    return view;
  }));

  router.delete(`${base}/settings/speaking-speed`, write((ctx, _r, _b, project) => { clearManualSpeakingWpm(ctx); return settingsView(ctx, project).speakingSpeed; }));
  router.get(`${base}/speaking-rate-samples`, read((ctx) => speakingRateSamples(ctx)));
  router.delete(`${base}/speaking-rate-samples/:sampleId`, write((ctx, req) => {
    deleteSpeakingRateSample(ctx, String(req.params.sampleId));
    return speakingSpeed(ctx);
  }));

  // ---- targets -------------------------------------------------------------
  router.get(`${base}/targets`, read((ctx) => ({ targets: readAllTargets(ctx), evaluationDays: evaluationDays(ctx) })));
  router.get(`${base}/targets/history`, read((ctx) => ({ entries: targetHistory(ctx) })));
  router.put(`${base}/targets/:platform`, write((ctx, req, b) => {
    const platform = parsePlatformParam(param(req, 'platform'));
    const saved = putTargets(ctx, platform, b);
    if (saved.changed) insights.targetsChanged(ctx);
    return { platform, targets: saved.targets };
  }));

  // ---- insights ------------------------------------------------------------
  router.get(`${base}/insights`, read((ctx) => insights.view(ctx)));
  router.post(`${base}/insights/refresh`, write((ctx) => insights.refresh(ctx), 202));
  router.post(`${base}/insights/stop`, write((ctx) => insights.stop(ctx)));
  router.get(`${base}/insights/history`, read((ctx) => ({ entries: insights.history(ctx) })));
  router.put(`${base}/insights/notes`, write((ctx, _r, b) => insights.putNotes(ctx, b)));

  // ---- knowledge -----------------------------------------------------------
  router.get(`${base}/knowledge/sections`, read((ctx) => listSections(ctx).then((sections) => ({ sections }))));
  router.post(`${base}/knowledge/sections`, write((ctx, _r, b) => createSection(ctx, b), 201));
  router.get(`${base}/knowledge/sections/:sid`, read((ctx, req) => readSection(ctx, param(req, 'sid'))));
  router.put(`${base}/knowledge/sections/:sid`, write((ctx, req, b) => putSection(ctx, param(req, 'sid'), b)));
  router.delete(`${base}/knowledge/sections/:sid`, write((ctx, req) => deleteSection(ctx, param(req, 'sid')), 204));
  router.get(`${base}/knowledge/colours`, read((ctx) => readColours(ctx).then((colours) => ({ colours }))));
  router.put(`${base}/knowledge/colours`, write(async (ctx, _r, b) => ({ colours: await putColours(ctx, b) })));
  router.get(`${base}/knowledge/files`, read((ctx) => listBrandFiles(ctx).then((files) => ({ files }))));
  // Files arrive as raw bytes (not base64 JSON). The window is a little over the file limit, so a file just over it is a 400 and a larger body a 413.
  const raw = express.raw({ type: () => true, limit: FILE_BODY_WINDOW });
  router.post(`${base}/knowledge/files`, raw, route(async (req, res) => {
    const project = await contentProject(req);
    refuseIfReadOnly(project);
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ctx = contentCtx(project);
    res.status(201).json(await ctx.exclusive(() => addBrandFile(ctx, req.query.name, bytes)));
  }));
  router.get(`${base}/knowledge/files/:name`, route(async (req, res) => {
    const f = await readBrandFile(contentCtx(await contentProject(req)), param(req, 'name'));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('application/octet-stream').send(f.bytes);
  }));
  router.delete(`${base}/knowledge/files/:name`, write((ctx, req) => deleteBrandFile(ctx, param(req, 'name')), 204));

  // ---- writing style -------------------------------------------------------
  router.get(`${base}/writing-style`, read((ctx) => readStyle(ctx)));
  router.put(`${base}/writing-style`, write((ctx, _r, b) => putStyle(ctx, b)));
  router.get(`${base}/writing-style/history`, read((ctx) => ({ entries: styleHistory(ctx) })));

  // ---- writing-style retro -------------------------------------------------
  const { retros } = studioSessions;
  router.get(`${base}/retros`, read((ctx) => ({ entries: retroLog(ctx) })));
  router.post(`${base}/assets/:assetId/retro`, write((ctx, req) => retros.run(ctx, recordId(req, 'assetId')), 202));
  router.get(`${base}/concepts/:cid/learn`, read((ctx, req) => retros.learnStatus(ctx, cid(req))));
  router.post(`${base}/concepts/:cid/learn`, write((ctx, req) => retros.learn(ctx, cid(req)), 202));
  router.get(`${base}/style-proposals`, read((ctx) => ({ proposals: pendingProposals(ctx) })));
  router.post(`${base}/style-proposals/:proposalId/accept`, write((ctx, req, b) => retros.accept(ctx, recordId(req, 'proposalId'), b)));
  router.post(`${base}/style-proposals/:proposalId/discard`, write((ctx, req) => retros.discard(ctx, recordId(req, 'proposalId'))));
}
