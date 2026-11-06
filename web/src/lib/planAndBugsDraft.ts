import { createDraftStore, type DraftStorage } from './draftStorage';

export type PlanAndBugsDraftStorage = DraftStorage;

const planAndBugsDrafts = createDraftStore('agent-visual-os.plan-and-bugs-draft.');

/** Keeps each project's unsent Plan & bugs request in a draft of its own, never mixed with its Task draft. */
export const planAndBugsDraftStorageKey = planAndBugsDrafts.storageKey;
export const readPlanAndBugsDraft = planAndBugsDrafts.read;
export const savePlanAndBugsDraft = planAndBugsDrafts.save;
export const clearPlanAndBugsDraft = planAndBugsDrafts.clear;
