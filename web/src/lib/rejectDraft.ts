import { createDraftStore, type DraftStorage } from './draftStorage';

export type RejectDraftStorage = DraftStorage;

const rejectDrafts = createDraftStore('agent-visual-os.reject-draft.');

/** Keeps the rejection reason being typed for each run in a draft of its own, so two runs never share one. */
export const rejectDraftStorageKey = rejectDrafts.storageKey;
export const readRejectDraft = rejectDrafts.read;
export const saveRejectDraft = rejectDrafts.save;
export const clearRejectDraft = rejectDrafts.clear;
