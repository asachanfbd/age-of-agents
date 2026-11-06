/** Every CRM limit as a named number; the product doc and the tests quote these names. */
export const MB = 1_048_576;
export const CSV_MAX_BYTES = 15 * MB;
export const CSV_MAX_ROWS = 50_000;
export const COMMENT_MAX = 5_000;
export const WORK_TITLE_MAX = 200;
export const WORK_SUMMARY_MAX = 1_000;
export const WORK_PROMPT_MAX = 4_000;
export const WORK_LOG_MAX = 50;
export const WORK_BACKFILL_DAYS = 30;
export const WORK_SUMMARY_TIMEOUT_MS = 60_000;
/** How long a paste column suggestion waits for the agent, the same as a work update. */
export const PASTE_AGENT_TIMEOUT_MS = WORK_SUMMARY_TIMEOUT_MS;
export const UNTITLED_TASK = 'Untitled task';
export const CUSTOM_FIELDS_MAX = 20;
export const CUSTOM_VALUE_MAX = 500;
export const MOM_ATTACHMENT_MAX_BYTES = 20 * MB;
export const MOM_ATTACHMENTS_MAX = 10;
export const LIST_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;
export const FOLLOWUPS_MAX = 10;
export const EMAIL_DAILY_CAP = 50;
export const EMAIL_GAP_SECONDS = 60;
export const ON_TIME_MINUTES = 30;
export const RETRY_DELAY_HOURS = 2;
export const RETRY_TRIES = 3;
export const GAP_DAYS_MAX = 365;
export const SENT_NO_RESPONSE_DAYS = 30;
export const PHONE_DIGITS_MAX = 15;
/** Largest event-loop stall tolerated while applying an import commit. */
export const IMPORT_LAG_BUDGET_MS = 1_500;

/** The tabs of a CRM Building, first to last. */
export const CRM_TABS = ['Calendar', 'Prospects', 'Customers', 'Lost', 'Import', 'Merge', 'Notes (MOM)', 'Reports', 'Settings'] as const;
