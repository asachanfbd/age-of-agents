import type { Request, RequestHandler, Response, Router } from 'express';
import { checkStorageThreshold } from '../buildings/buildingStorage.ts';
import { validateThreshold } from '../buildings/storageStatus.ts';
import { projectsDb } from '../db/collections.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { ProjectNotFoundError } from '../projects/projectService.ts';
import { completeConsent, connectAds, connectBing, connectionsView, disconnect, isGoogleService, listProperties, saveIndexNowKey, selectProperty, startConsent } from '../seo/connections.ts';
import { clearGoogleClient, googleClientSaved, saveGoogleClient } from '../seo/googleClient.ts';
import { acknowledgeRetention, dataStatus, discardNow, retentionPreview, series, setRetentionMonths } from '../seo/dataStatus.ts';
import type { Grain } from '../seo/dataStatus.ts';
import { SeoInputError, SeoNotFoundError } from '../seo/errors.ts';
import { backlinkDomains, backlinkOverview, backlinkTargets, commitImport, deleteLink, exportLinks, listBatches, listLinks, listMappings, previewImport, setNote } from '../seo/backlinks.ts';
import { addKeywords, applySuggestion, clusterCreate, clusterDelete, clusterMerge, clusterRename, clusterSplit, clustersReport, dismissSuggestion, exportKeywords, importKeywords, keywordDetail, keywordsMove, keywordsReport, listSuggestions, updateKeyword } from '../seo/keywords.ts';
import { acceptProposals, latestRun, listProposals, refreshVolumes, rejectProposals, setKeywordMarket, startClustering, startResearch, stopRun } from '../seo/keywordRuns.ts';
import type { RunKind } from '../seo/keywordRuns.ts';
import { checkKeyFile, submissionLog, submitToIndexNow } from '../seo/indexNow.ts';
import { inspectNow, quotaStatus } from '../seo/inspection.ts';
import { syncBuildingIfStale, ON_OPEN_FRESH_MS } from '../seo/maintenance.ts';
import { currentRun, internalLinksOverview, startCrawl, stopCrawl, updateCrawlSettings } from '../seo/crawl/service.ts';
import { crawlLogCsv, crawlLogFileName, crawlLogOf, crawlLogPage } from '../seo/crawl/crawlLog.ts';
import { compareForBuilding, graphOf, matrixCsv, matrixFileName, matrixOf, pageLinks, snapshotFor } from '../seo/crawl/views.ts';
import { pageDetail, pagesReport } from '../seo/pages.ts';
import { trackJob, listRunningJobs } from '../seo/jobs.ts';
import { refreshSitemaps, rereadSitemap, sitemapsView } from '../seo/sitemaps.ts';
import { checkBing, listSitemapUrls } from '../seo/sitemapUrls.ts';
import { latestSync, startSync } from '../seo/sync.ts';
import { mountSeoReportRoutes } from './seoReportRoutes.ts';
import { mountSeoTaskRoutes } from './seoTaskRoutes.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;
type ParamReader = (req: Request, name: string) => string;

const page = (title: string, message: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;background:#0b1220;color:#e6edf3;padding:3rem"><h2>${title}</h2><p>${message}</p></body>`;
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The SEO Building's API: Connections, sync, data status and retention, and metric series. Every route 404s for a Building that is not an SEO Building. */
export function mountSeoRoutes(router: Router, route: RouteWrapper, param: ParamReader, scheduler: Scheduler): void {
  const seoProject = async (req: Request): Promise<ProjectRecord> => {
    const project = await projectsDb.get(param(req, 'id'));
    if (!project) throw new ProjectNotFoundError();
    if (project.typeId !== 'seo') throw new SeoNotFoundError();
    return project;
  };
  const base = '/projects/:id/seo';

  // Every Building's running SEO jobs, for the status footer.
  router.get('/seo/jobs/running', route(async (_req, res) => {
    res.json({ jobs: listRunningJobs() });
  }));
  mountSeoTaskRoutes(router, route, param, scheduler, seoProject);
  mountSeoReportRoutes(router, route, param, scheduler, seoProject);
  const googleService = (req: Request) => {
    const service = param(req, 'service');
    if (!isGoogleService(service)) throw new SeoInputError('service must be gsc, ga4 or ads');
    return service;
  };
  const propertyService = (req: Request) => {
    const service = googleService(req);
    if (service === 'ads') throw new SeoInputError('service must be gsc or ga4');
    return service;
  };

  router.get(`${base}/connections`, route(async (req, res) => {
    res.json(await connectionsView((await seoProject(req)).id));
  }));

  // The app-wide Google client (Settings > Google (SEO)). Write-only: the answer only says whether one is saved.
  const googleClientRoute = '/settings/google-oauth-client';
  router.get(googleClientRoute, route(async (_req, res) => {
    res.json({ saved: await googleClientSaved() });
  }));
  router.put(googleClientRoute, route(async (req, res) => {
    await saveGoogleClient(req.body?.clientId, req.body?.clientSecret);
    res.json({ saved: true });
  }));
  router.delete(googleClientRoute, route(async (_req, res) => {
    await clearGoogleClient();
    res.status(204).end();
  }));

  router.post(`${base}/connections/:service/connect`, route(async (req, res) => {
    const project = await seoProject(req);
    // From the socket the request arrived on, not the Host header, so a forged Host cannot change where Google sends the person.
    const redirectUri = `http://127.0.0.1:${req.socket.localPort}/api/seo/oauth/callback`;
    res.json(await startConsent(project.id, googleService(req), redirectUri));
  }));

  // Google redirects the person's browser here, so it is not tied to a Building id: the single-use state names it.
  router.get('/seo/oauth/callback', route(async (req, res) => {
    const result = await completeConsent({ code: req.query.code, state: req.query.state, error: req.query.error });
    res.status(result.ok ? 200 : 400).type('html').send(page(result.ok ? 'Connected' : 'Not connected', escapeHtml(result.message)));
  }));

  router.get(`${base}/connections/:service/properties`, route(async (req, res) => {
    const project = await seoProject(req);
    res.json({ properties: await listProperties(project.id, propertyService(req)) });
  }));

  router.put(`${base}/connections/:service/property`, route(async (req, res) => {
    const project = await seoProject(req);
    await selectProperty(project.id, propertyService(req), req.body?.property, req.body?.confirm === true);
    res.json(await connectionsView(project.id));
  }));

  router.put(`${base}/connections/ads`, route(async (req, res) => {
    const project = await seoProject(req);
    const check = await connectAds(project.id, req.body ?? {});
    res.json({ ...check, connections: await connectionsView(project.id) });
  }));

  router.put(`${base}/connections/bing`, route(async (req, res) => {
    const project = await seoProject(req);
    const check = await connectBing(project.id, req.body?.apiKey);
    res.json({ ...check, connections: await connectionsView(project.id) });
  }));

  router.put(`${base}/connections/indexnow`, route(async (req, res) => {
    const project = await seoProject(req);
    await saveIndexNowKey(project.id, req.body?.key);
    res.json(await connectionsView(project.id));
  }));

  router.delete(`${base}/connections/:service`, route(async (req, res) => {
    const project = await seoProject(req);
    const service = param(req, 'service');
    if (!['gsc', 'ga4', 'ads', 'bing', 'indexnow'].includes(service)) throw new SeoInputError('unknown service');
    await disconnect(project.id, service as 'gsc');
    res.json(await connectionsView(project.id));
  }));

  router.post(`${base}/sync`, route(async (req, res) => {
    res.status(202).json(await startSync(await seoProject(req)));
  }));

  router.post(`${base}/sync/on-open`, route(async (req, res) => {
    const project = await seoProject(req);
    res.json({ started: await syncBuildingIfStale(project.id, ON_OPEN_FRESH_MS) });
  }));

  router.get(`${base}/sync`, route(async (req, res) => {
    res.json(latestSync((await seoProject(req)).id) ?? null);
  }));

  router.get(`${base}/data`, route(async (req, res) => {
    res.json(await dataStatus(await seoProject(req)));
  }));

  router.patch(`${base}/data`, route(async (req, res) => {
    const project = await seoProject(req);
    const { retentionMonths, warningBytes } = req.body ?? {};
    if (retentionMonths === undefined && warningBytes === undefined) throw new SeoInputError('retentionMonths or warningBytes is required');
    if (warningBytes !== undefined) {
      let value: number;
      try { value = validateThreshold(warningBytes); } catch (error) { throw new SeoInputError((error as Error).message); }
      if (retentionMonths !== undefined) await setRetentionMonths(project.id, retentionMonths);
      await projectsDb.update(project.id, { storageWarningBytes: value, updatedAt: new Date().toISOString() });
      await checkStorageThreshold(project.id);
    } else {
      await setRetentionMonths(project.id, retentionMonths);
    }
    res.json(await dataStatus((await projectsDb.get(project.id))!));
  }));

  router.get(`${base}/data/discard/preview`, route(async (req, res) => {
    res.json(await retentionPreview(await seoProject(req)));
  }));

  router.post(`${base}/data/discard/acknowledge`, route(async (req, res) => {
    const project = await seoProject(req);
    await acknowledgeRetention(project.id);
    res.json(await retentionPreview(project));
  }));

  router.post(`${base}/data/discard`, route(async (req, res) => {
    res.status(202).json(await discardNow(await seoProject(req)));
  }));

  router.get(`${base}/pages`, route(async (req, res) => {
    res.json(await pagesReport(await seoProject(req), req.query));
  }));

  router.get(`${base}/pages/detail`, route(async (req, res) => {
    res.json(await pageDetail(await seoProject(req), req.query));
  }));

  router.get(`${base}/backlinks`, route(async (req, res) => {
    res.json(await listLinks(await seoProject(req), req.query));
  }));

  router.get(`${base}/backlinks/overview`, route(async (req, res) => {
    res.json(await backlinkOverview(await seoProject(req), req.query));
  }));

  router.get(`${base}/backlinks/domains`, route(async (req, res) => {
    res.json(await backlinkDomains(await seoProject(req)));
  }));

  router.get(`${base}/backlinks/targets`, route(async (req, res) => {
    res.json(await backlinkTargets(await seoProject(req)));
  }));

  router.get(`${base}/backlinks/batches`, route(async (req, res) => {
    res.json({ batches: await listBatches(await seoProject(req)) });
  }));

  router.get(`${base}/backlinks/mappings`, route(async (req, res) => {
    res.json({ mappings: await listMappings(await seoProject(req)) });
  }));

  router.get(`${base}/backlinks/export`, route(async (req, res) => {
    const csv = await exportLinks(await seoProject(req), req.query);
    res.type('text/csv').set('content-disposition', 'attachment; filename="backlinks.csv"').send(csv);
  }));

  router.post(`${base}/backlinks/import/preview`, route(async (req, res) => {
    res.json(await previewImport(await seoProject(req), req.body ?? {}));
  }));

  router.post(`${base}/backlinks/import`, route(async (req, res) => {
    res.status(201).json(await commitImport(await seoProject(req), req.body ?? {}));
  }));

  router.put(`${base}/backlinks/:uid/note`, route(async (req, res) => {
    res.json(await setNote(await seoProject(req), param(req, 'uid'), req.body?.note));
  }));

  router.delete(`${base}/backlinks/:uid`, route(async (req, res) => {
    await deleteLink(await seoProject(req), param(req, 'uid'));
    res.status(204).end();
  }));

  router.get(`${base}/keywords/clusters`, route(async (req, res) => {
    res.json(await clustersReport(await seoProject(req), req.query));
  }));

  router.get(`${base}/keywords`, route(async (req, res) => {
    res.json(await keywordsReport(await seoProject(req), req.query));
  }));

  router.get(`${base}/keywords/detail`, route(async (req, res) => {
    res.json(await keywordDetail(await seoProject(req), req.query));
  }));

  router.get(`${base}/keywords/export`, route(async (req, res) => {
    const csv = await exportKeywords(await seoProject(req), req.query);
    res.type('text/csv').set('content-disposition', 'attachment; filename="keywords.csv"').send(csv);
  }));

  router.post(`${base}/keywords`, route(async (req, res) => {
    res.json(await addKeywords(await seoProject(req), req.body?.keywords));
  }));

  router.post(`${base}/keywords/import`, route(async (req, res) => {
    res.json(await importKeywords(await seoProject(req), req.body?.csv));
  }));

  router.patch(`${base}/keywords/item`, route(async (req, res) => {
    res.json(await updateKeyword(await seoProject(req), req.body ?? {}));
  }));

  router.post(`${base}/keywords/move`, route(async (req, res) => {
    await keywordsMove(await seoProject(req), req.body?.keys, req.body?.clusterId);
    res.json({ moved: true });
  }));

  router.post(`${base}/keywords/clusters`, route(async (req, res) => {
    res.status(201).json(await clusterCreate(await seoProject(req), req.body?.name));
  }));

  router.post(`${base}/keywords/clusters/merge`, route(async (req, res) => {
    await clusterMerge(await seoProject(req), req.body?.sourceIds, req.body?.targetId);
    res.json({ merged: true });
  }));

  router.patch(`${base}/keywords/clusters/:cid`, route(async (req, res) => {
    await clusterRename(await seoProject(req), param(req, 'cid'), req.body?.name);
    res.json({ renamed: true });
  }));

  router.delete(`${base}/keywords/clusters/:cid`, route(async (req, res) => {
    await clusterDelete(await seoProject(req), param(req, 'cid'));
    res.json({ deleted: true });
  }));

  router.post(`${base}/keywords/clusters/:cid/split`, route(async (req, res) => {
    res.status(201).json(await clusterSplit(await seoProject(req), param(req, 'cid'), req.body?.keys, req.body?.name));
  }));

  const runKind = (kind: RunKind, start: (project: ProjectRecord, body: Record<string, unknown>) => Promise<unknown>) => {
    const path = `${base}/keywords/${kind === 'cluster' ? 'cluster-run' : 'research-run'}`;
    router.post(path, route(async (req, res) => { res.status(202).json(await start(await seoProject(req), req.body ?? {})); }));
    router.get(path, route(async (req, res) => { res.json(await latestRun(await seoProject(req), kind)); }));
    router.post(`${path}/stop`, route(async (req, res) => { res.json(await stopRun(await seoProject(req), kind)); }));
  };
  runKind('cluster', (project) => startClustering(project));
  runKind('research', (project, body) => startResearch(project, body));

  router.get(`${base}/keywords/suggestions`, route(async (req, res) => {
    res.json({ suggestions: await listSuggestions(await seoProject(req)) });
  }));

  router.post(`${base}/keywords/suggestions/:sid/apply`, route(async (req, res) => {
    await applySuggestion(await seoProject(req), param(req, 'sid'));
    res.json({ applied: true });
  }));

  router.post(`${base}/keywords/suggestions/:sid/dismiss`, route(async (req, res) => {
    await dismissSuggestion(await seoProject(req), param(req, 'sid'));
    res.json({ dismissed: true });
  }));

  router.get(`${base}/keywords/proposals`, route(async (req, res) => {
    res.json(await listProposals(await seoProject(req), typeof req.query.status === 'string' ? req.query.status : undefined));
  }));

  router.post(`${base}/keywords/proposals/accept`, route(async (req, res) => {
    res.json(await acceptProposals(await seoProject(req), req.body?.ids, req.body?.clusterId));
  }));

  router.post(`${base}/keywords/proposals/reject`, route(async (req, res) => {
    res.json(await rejectProposals(await seoProject(req), req.body?.ids));
  }));

  router.put(`${base}/keywords/market`, route(async (req, res) => {
    await setKeywordMarket(await seoProject(req), req.body?.languageId, req.body?.locationId);
    res.json({ saved: true });
  }));

  router.post(`${base}/keywords/volumes/refresh`, route(async (req, res) => {
    res.json(await refreshVolumes(await seoProject(req)));
  }));

  router.get(`${base}/sitemaps`, route(async (req, res) => {
    const project = await seoProject(req);
    const [view, quota] = await Promise.all([sitemapsView(project), quotaStatus(project)]);
    res.json({ ...view, quota });
  }));

  router.post(`${base}/sitemaps/read`, route(async (req, res) => {
    const project = await seoProject(req);
    res.json(await trackJob(project.id, 'sitemaps', () => refreshSitemaps(project)));
  }));

  router.post(`${base}/sitemaps/reread`, route(async (req, res) => {
    res.json(await rereadSitemap(await seoProject(req), req.body?.sitemap));
  }));

  router.get(`${base}/sitemaps/urls`, route(async (req, res) => {
    res.json(await listSitemapUrls(await seoProject(req), req.query));
  }));

  router.post(`${base}/sitemaps/urls/inspect`, route(async (req, res) => {
    res.json(await inspectNow(await seoProject(req), req.body?.urls));
  }));

  router.post(`${base}/sitemaps/bing-check`, route(async (req, res) => {
    res.json({ results: await checkBing(await seoProject(req), req.body?.urls) });
  }));

  router.get(`${base}/indexnow/key-check`, route(async (req, res) => {
    res.json(await checkKeyFile(await seoProject(req)));
  }));

  router.post(`${base}/indexnow/key-check`, route(async (req, res) => {
    res.json(await checkKeyFile(await seoProject(req), true));
  }));

  router.post(`${base}/indexnow/submit`, route(async (req, res) => {
    const { mode, urls, sitemap } = req.body ?? {};
    if (mode !== 'selected' && mode !== 'sitemap' && mode !== 'new-or-changed') throw new SeoInputError('mode must be selected, sitemap or new-or-changed');
    res.json(await submitToIndexNow(await seoProject(req), mode === 'selected' ? { mode, urls } : mode === 'sitemap' ? { mode, sitemap } : { mode, sitemap }));
  }));

  router.get(`${base}/indexnow/log`, route(async (req, res) => {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new SeoInputError('limit must be a whole number from 1 to 200');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) throw new SeoInputError('offset must be a whole number from 0 to 10000000');
    const url = typeof req.query.url === 'string' && req.query.url ? req.query.url : undefined;
    res.json(await submissionLog(await seoProject(req), { limit, offset, url }));
  }));

  const links = `${base}/internal-links`;
  router.get(links, route(async (req, res) => {
    res.json(await internalLinksOverview(await seoProject(req)));
  }));

  router.put(`${links}/settings`, route(async (req, res) => {
    res.json(await updateCrawlSettings(await seoProject(req), req.body));
  }));

  router.post(`${links}/crawl`, route(async (req, res) => {
    res.status(202).json(await startCrawl(await seoProject(req), { resume: req.body?.resume === true }));
  }));

  router.get(`${links}/crawl`, route(async (req, res) => {
    res.json(await currentRun((await seoProject(req)).id));
  }));

  router.post(`${links}/crawl/stop`, route(async (req, res) => {
    res.json(await stopCrawl((await seoProject(req)).id));
  }));

  router.get(`${links}/graph`, route(async (req, res) => {
    const project = await seoProject(req);
    res.json(graphOf(await snapshotFor(project.id, req.query.snapshot)));
  }));

  router.get(`${links}/page`, route(async (req, res) => {
    const project = await seoProject(req);
    res.json(pageLinks(await snapshotFor(project.id, req.query.snapshot), req.query.url));
  }));

  router.get(`${links}/log`, route(async (req, res) => {
    const project = await seoProject(req);
    res.json(crawlLogOf(await snapshotFor(project.id, req.query.snapshot), req.query));
  }));

  router.get(`${links}/log/page`, route(async (req, res) => {
    const project = await seoProject(req);
    res.json(crawlLogPage(await snapshotFor(project.id, req.query.snapshot), req.query.url));
  }));

  router.get(`${links}/log/export`, route(async (req, res) => {
    const project = await seoProject(req);
    const snapshot = await snapshotFor(project.id, req.query.snapshot);
    const csv = crawlLogCsv(snapshot, req.query);
    res.type('text/csv').set('content-disposition', `attachment; filename="${crawlLogFileName(snapshot)}"`).send(csv);
  }));

  router.post(`${links}/matrix`, route(async (req, res) => {
    const project = await seoProject(req);
    res.json(matrixOf(await snapshotFor(project.id, req.body?.snapshot), req.body ?? {}));
  }));

  router.post(`${links}/matrix/export`, route(async (req, res) => {
    const project = await seoProject(req);
    const snapshot = await snapshotFor(project.id, req.body?.snapshot);
    const csv = matrixCsv(matrixOf(snapshot, req.body ?? {}));
    res.type('text/csv').set('content-disposition', `attachment; filename="${matrixFileName(req.body?.name, snapshot)}"`).send(csv);
  }));

  router.get(`${links}/compare`, route(async (req, res) => {
    res.json(await compareForBuilding((await seoProject(req)).id, req.query));
  }));

  router.get(`${base}/series`, route(async (req, res) => {
    const project = await seoProject(req);
    const { dataset, from, to, grain } = req.query;
    if (dataset !== 'gsc' && dataset !== 'ga4') throw new SeoInputError('dataset must be gsc or ga4');
    res.json(await series(project, dataset, from, to, (typeof grain === 'string' ? grain : 'day') as Grain));
  }));
}
