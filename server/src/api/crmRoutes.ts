import express from 'express';
import type { Request, RequestHandler, Response, Router } from 'express';
import { normalizeProject } from '../buildings/normalize.ts';
import { projectsDb } from '../db/collections.ts';
import type { ProjectRecord } from '../domain/types.ts';
import { ProjectNotFoundError } from '../projects/projectService.ts';
import { calendar, decideBlock, expandToday, overrideSlot } from '../crm/calendar.ts';
import type { CrmCtx } from '../crm/context.ts';
import { addChannel, createContact, getContact, listContacts, markCustomer, markLost, patchChannel, patchContact, removeChannel, reopen, setContactDnc, setStage } from '../crm/contacts.ts';
import { attachBuilding, detachBuilding, listCustomers, listLost } from '../crm/customers.ts';
import { acceptMessageDraft, discardMessageDraft, requestDraft } from '../crm/drafts.ts';
import { approveItem, assertSmtpReady, sendApproved, testSend } from '../crm/email.ts';
import { tick } from '../crm/engine.ts';
import { CrmConflictError, CrmInputError, CrmNotFoundError } from '../crm/errors.ts';
import { catchUpAction, completeItem, createReachout, createTask, editMessage, followupView, getFollowup, listFollowups, rejectItem, submitManual } from '../crm/followups.ts';
import { commitCsv, importPaste, listBatches, previewCsv, suggestPaste } from '../crm/imports.ts';
import { MOM_ATTACHMENT_MAX_BYTES } from '../crm/limits.ts';
import { dismissPair, listMerges, listSuggestions, mergeContacts, undoMerge } from '../crm/merge.ts';
import { acceptDraft, actionItemToFollowup, addFile, analyse, createMom, deleteFile, discardDraft, getMom, listMoms, patchMom, readFileBytes, transcribe } from '../crm/mom.ts';
import { parseLimit, parseOffset } from '../crm/paging.ts';
import { buildReport, reportCsv } from '../crm/reports.ts';
import { logResponse } from '../crm/responses.ts';
import { crmCtx } from '../crm/runtime.ts';
import { sendsWithoutApproval } from '../crm/settings.ts';
import { addCustomField, deleteCustomField, renameCustomField, renameLostReason, settingsView, updateSettings } from '../crm/settingsService.ts';
import { addComment, deleteComment, editComment, listTimeline } from '../crm/timeline.ts';

type RouteWrapper = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;
type ParamReader = (req: Request, name: string) => string;

/** The CRM Building's API under `/projects/:id/crm`. Every route 404s for a Building that is not a CRM Building; every write route answers 409 for a read-only one. */
export function mountCrmRoutes(router: Router, route: RouteWrapper, param: ParamReader): void {
  const base = '/projects/:id/crm';
  const crmProject = async (req: Request): Promise<ProjectRecord> => {
    const project = await projectsDb.get(param(req, 'id'));
    if (!project) throw new ProjectNotFoundError();
    if (project.typeId !== 'crm') throw new CrmNotFoundError('This is not a CRM Building');
    return project;
  };
  const intParam = (req: Request, name: string): number => {
    const v = param(req, name);
    if (!/^\d{1,15}$/.test(v)) throw new CrmNotFoundError('Not found');
    return Number(v);
  };
  const bodyOf = (req: Request): unknown => {
    const b = req.body as unknown;
    if (b !== undefined && (typeof b !== 'object' || b === null || Array.isArray(b))) throw new CrmInputError('The request body must be a JSON object');
    return b ?? {};
  };

  const read = <T>(handler: (ctx: CrmCtx, req: Request, res: Response) => T | Promise<T>): RequestHandler => route(async (req, res) => {
    const ctx = await crmCtx(await crmProject(req));
    res.json(await handler(ctx, req, res));
  });
  /** A write: refused on a read-only Building, run one at a time per Building. `status` may depend on the body. */
  const write = <T>(handler: (ctx: CrmCtx, req: Request, body: any) => T | Promise<T>, statusFor: number | ((body: any) => number) = 200): RequestHandler => route(async (req, res) => {
    const project = await crmProject(req);
    const view = normalizeProject(project);
    if (view.readOnly) throw new CrmConflictError(view.readOnlyReason ?? 'This Building is read-only.');
    const body = bodyOf(req);
    const ctx = await crmCtx(project);
    const out = await ctx.exclusive(async () => handler(ctx, req, body));
    const status = typeof statusFor === 'number' ? statusFor : statusFor(body);
    if (status === 204) { res.status(204).end(); return; }
    res.status(status).json(out);
  });

  const cid = (req: Request) => intParam(req, 'cid');
  const fid = (req: Request) => intParam(req, 'fid');
  const mid = (req: Request) => intParam(req, 'mid');

  // ---- contacts ----------------------------------------------------------
  router.get(`${base}/contacts`, read((ctx, req) => listContacts(ctx, req.query)));
  router.post(`${base}/contacts`, write((ctx, _r, b) => createContact(ctx, b), 201));
  router.get(`${base}/contacts/:cid`, read((ctx, req) => getContact(ctx, cid(req))));
  router.patch(`${base}/contacts/:cid`, write((ctx, req, b) => patchContact(ctx, cid(req), b)));
  router.post(`${base}/contacts/:cid/channels`, write((ctx, req, b) => addChannel(ctx, cid(req), b), 201));
  router.patch(`${base}/contacts/:cid/channels/:chid`, write((ctx, req, b) => patchChannel(ctx, cid(req), intParam(req, 'chid'), b)));
  router.delete(`${base}/contacts/:cid/channels/:chid`, write((ctx, req) => removeChannel(ctx, cid(req), intParam(req, 'chid'))));
  router.put(`${base}/contacts/:cid/dnc`, write((ctx, req, b) => setContactDnc(ctx, cid(req), b.dnc)));
  router.put(`${base}/contacts/:cid/stage`, write((ctx, req, b) => setStage(ctx, cid(req), b.stage)));
  router.post(`${base}/contacts/:cid/lost`, write((ctx, req, b) => markLost(ctx, cid(req), b.reason)));
  router.post(`${base}/contacts/:cid/reopen`, write((ctx, req, b) => reopen(ctx, cid(req), b.stage)));
  router.post(`${base}/contacts/:cid/customer`, write((ctx, req) => markCustomer(ctx, cid(req))));
  router.post(`${base}/contacts/:cid/responses`, write((ctx, req, b) => logResponse(ctx, cid(req), b)));
  router.get(`${base}/contacts/:cid/merges`, read((ctx, req) => { getContact(ctx, cid(req)); return listMerges(ctx, cid(req)); }));

  // ---- timeline ----------------------------------------------------------
  router.get(`${base}/contacts/:cid/timeline`, read((ctx, req) => { getContact(ctx, cid(req)); return listTimeline(ctx, cid(req), req.query.limit, req.query.offset); }));
  router.post(`${base}/contacts/:cid/timeline/comments`, write((ctx, req, b) => { getContact(ctx, cid(req)); return addComment(ctx, cid(req), b.text); }, 201));
  router.patch(`${base}/contacts/:cid/timeline/:eid`, write((ctx, req, b) => { getContact(ctx, cid(req)); return editComment(ctx, cid(req), intParam(req, 'eid'), b.text); }));
  router.delete(`${base}/contacts/:cid/timeline/:eid`, write((ctx, req) => { getContact(ctx, cid(req)); deleteComment(ctx, cid(req), intParam(req, 'eid')); }, 204));

  // ---- reachouts, followups, approval ------------------------------------
  router.post(`${base}/contacts/:cid/reachouts`, write(async (ctx, req, b) => {
    // With "send without approval" on, an unusable connection is refused before anything is created.
    const channel = getContact(ctx, cid(req)).channels.find((c) => c.id === b.channelId);
    if (channel?.type === 'email' && sendsWithoutApproval(ctx.settings(), 'email')) await assertSmtpReady(ctx);
    const out = createReachout(ctx, cid(req), b);
    if (out.autoApproved) { await sendApproved(ctx, out.followup.id); return followupView(ctx, getFollowup(ctx, out.followup.id)); }
    return out.followup;
  }, 201));
  router.post(`${base}/contacts/:cid/followups`, write((ctx, req, b) => createTask(ctx, cid(req), b), 201));
  router.get(`${base}/followups`, read((ctx, req) => listFollowups(ctx, req.query)));
  router.get(`${base}/followups/:fid`, read((ctx, req) => followupView(ctx, getFollowup(ctx, fid(req)))));
  router.put(`${base}/followups/:fid/message`, write((ctx, req, b) => editMessage(ctx, fid(req), b.message)));
  router.post(`${base}/followups/:fid/submit`, write((ctx, req, b) => submitManual(ctx, fid(req), b)));
  router.post(`${base}/followups/:fid/catch-up`, write((ctx, req, b) => catchUpAction(ctx, fid(req), b)));
  router.post(`${base}/followups/:fid/approve`, write(async (ctx, req, b) => {
    approveItem(ctx, fid(req), b.message);
    const out = await sendApproved(ctx, fid(req));
    return { followup: followupView(ctx, getFollowup(ctx, fid(req))), delivery: out };
  }));
  router.post(`${base}/followups/:fid/reject`, write((ctx, req) => rejectItem(ctx, fid(req))));
  router.post(`${base}/followups/:fid/complete`, write((ctx, req) => completeItem(ctx, fid(req))));
  router.post(`${base}/followups/:fid/draft`, write((ctx, req) => requestDraft(ctx, fid(req))));
  router.post(`${base}/followups/:fid/draft/accept`, write((ctx, req, b) => acceptMessageDraft(ctx, fid(req), b.message)));
  router.delete(`${base}/followups/:fid/draft`, write((ctx, req) => discardMessageDraft(ctx, fid(req))));

  // ---- customers, lost, attached Buildings -------------------------------
  router.get(`${base}/customers`, read((ctx, req) => listCustomers(ctx, req.query)));
  router.get(`${base}/lost`, read((ctx, req) => listLost(ctx, req.query)));
  router.get(`${base}/buildings`, read(async (ctx) => ({ buildings: (await ctx.deps.buildings.list()).filter((b) => b.id !== ctx.buildingId) })));
  router.post(`${base}/contacts/:cid/buildings`, write((ctx, req, b) => attachBuilding(ctx, cid(req), b.buildingId), 201));
  router.delete(`${base}/contacts/:cid/buildings/:bid`, write((ctx, req) => detachBuilding(ctx, cid(req), param(req, 'bid'))));

  // ---- import ------------------------------------------------------------
  router.post(`${base}/import/csv/preview`, read(async (ctx, req) => previewCsv(ctx, bodyOf(req) as never)));
  router.post(`${base}/import/csv/commit`, write((ctx, _r, b) => commitCsv(ctx, b), 201));
  // A paste preview (`commit: false`) is refused on a read-only Building too; suggest writes nothing, so it is a read.
  router.post(`${base}/import/paste`, write((ctx, _r, b) => importPaste(ctx, b), (b) => (b.commit === false ? 200 : 201)));
  router.post(`${base}/import/paste/suggest`, read(async (ctx, req) => suggestPaste(ctx, bodyOf(req) as never)));
  router.get(`${base}/batches`, read((ctx) => ({ batches: listBatches(ctx) })));

  // ---- merge -------------------------------------------------------------
  router.post(`${base}/merge`, write((ctx, _r, b) => mergeContacts(ctx, b), 201));
  router.get(`${base}/merge/suggestions`, read((ctx, req) => {
    const limit = parseLimit(req.query.limit), offset = parseOffset(req.query.offset);
    const r = listSuggestions(ctx, limit, offset);
    return { ...r, limit, offset, hasMore: offset + r.rows.length < r.total };
  }));
  router.post(`${base}/merge/suggestions/dismiss`, write((ctx, _r, b) => { dismissPair(ctx, b.firstId, b.secondId); return { ok: true }; }));
  router.post(`${base}/merge/:mid/undo`, write((ctx, req, b) => undoMerge(ctx, mid(req), b)));

  // ---- calendar ----------------------------------------------------------
  // Reads never send mail or write: time-driven work runs from the minute timer or from this explicit refresh.
  router.post(`${base}/tick`, write((ctx) => tick(ctx)));
  router.get(`${base}/calendar`, read((ctx, req) => calendar(ctx, req.query)));
  router.get(`${base}/expand-today`, read((ctx) => expandToday(ctx)));
  router.post(`${base}/calendar/blocks/:day/:key`, write((ctx, req, b) => decideBlock(ctx, param(req, 'day'), param(req, 'key'), b)));
  router.put(`${base}/calendar/slots/:day/:slotId`, write((ctx, req, b) => overrideSlot(ctx, param(req, 'day'), param(req, 'slotId'), b)));

  // ---- MOM ---------------------------------------------------------------
  router.post(`${base}/moms`, write((ctx, _r, b) => createMom(ctx, b), 201));
  router.get(`${base}/moms`, read((ctx, req) => listMoms(ctx, req.query)));
  router.get(`${base}/moms/:mid`, read((ctx, req) => getMom(ctx, mid(req))));
  router.patch(`${base}/moms/:mid`, write((ctx, req, b) => patchMom(ctx, mid(req), b)));
  // Files arrive as raw bytes (not base64 JSON) so a 20 MB file fits under the daemon's 25 MB JSON body limit.
  const raw = express.raw({ type: () => true, limit: MOM_ATTACHMENT_MAX_BYTES + 1_048_576 });
  router.post(`${base}/moms/:mid/files`, raw, route(async (req, res) => {
    const project = await crmProject(req);
    const view = normalizeProject(project);
    if (view.readOnly) throw new CrmConflictError(view.readOnlyReason ?? 'This Building is read-only.');
    const kind = req.query.kind === 'audio' ? 'audio' : req.query.kind === undefined || req.query.kind === 'attachment' ? 'attachment' : null;
    if (!kind) throw new CrmInputError('kind must be attachment or audio', 'kind');
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ctx = await crmCtx(project);
    res.status(201).json(await ctx.exclusive(() => addFile(ctx, mid(req), kind, req.query.name, bytes)));
  }));
  router.get(`${base}/moms/:mid/files/:fileId`, route(async (req, res) => {
    const ctx = await crmCtx(await crmProject(req));
    const f = await readFileBytes(ctx, mid(req), intParam(req, 'fileId'));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.type('application/octet-stream').send(f.bytes);
  }));
  router.delete(`${base}/moms/:mid/files/:fileId`, write((ctx, req) => deleteFile(ctx, mid(req), intParam(req, 'fileId')), 204));
  router.post(`${base}/moms/:mid/transcribe`, write((ctx, req) => transcribe(ctx, mid(req))));
  router.post(`${base}/moms/:mid/analyse`, write((ctx, req) => analyse(ctx, mid(req))));
  router.post(`${base}/moms/:mid/draft/accept`, write((ctx, req, b) => acceptDraft(ctx, mid(req), b)));
  router.delete(`${base}/moms/:mid/draft`, write((ctx, req) => discardDraft(ctx, mid(req))));
  router.post(`${base}/moms/:mid/action-items/:index/followup`, write((ctx, req) => actionItemToFollowup(ctx, mid(req), intParam(req, 'index'))));

  // ---- reports -----------------------------------------------------------
  router.get(`${base}/reports`, read((ctx, req) => buildReport(ctx, req.query)));
  router.get(`${base}/reports/export`, route(async (req, res) => {
    const ctx = await crmCtx(await crmProject(req));
    const { name, csv } = reportCsv(ctx, req.query);
    res.type('text/csv').attachment(name).send(csv);
  }));

  // ---- settings ----------------------------------------------------------
  router.get(`${base}/settings`, read((ctx) => settingsView(ctx)));
  router.patch(`${base}/settings`, write((ctx, _r, b) => updateSettings(ctx, b)));
  router.post(`${base}/settings/custom-fields`, write((ctx, _r, b) => addCustomField(ctx, b.name), 201));
  router.patch(`${base}/settings/custom-fields/:fieldId`, write((ctx, req, b) => renameCustomField(ctx, param(req, 'fieldId'), b.name)));
  router.delete(`${base}/settings/custom-fields/:fieldId`, write((ctx, req) => deleteCustomField(ctx, param(req, 'fieldId')), 204));
  router.put(`${base}/settings/lost-reasons/:reason`, write((ctx, req, b) => ({ lostReasons: renameLostReason(ctx, param(req, 'reason'), b.name) })));
  router.post(`${base}/settings/smtp/test`, write((ctx, _r, b) => testSend(ctx, b.to)));
}
