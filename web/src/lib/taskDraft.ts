import { createDraftStore, type DraftStorage } from './draftStorage';

export type TaskDraftStorage = DraftStorage;

const taskDrafts = createDraftStore('agent-visual-os.task-draft.');

/** Keeps each project's unfinished task separate when the user moves between workspace popups. */
export const taskDraftStorageKey = taskDrafts.storageKey;
export const readTaskDraft = taskDrafts.read;
export const saveTaskDraft = taskDrafts.save;
export const clearTaskDraft = taskDrafts.clear;
