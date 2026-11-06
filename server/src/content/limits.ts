/** Every Content Studio limit as a named number; the product doc and the tests quote these names. */
export const MB = 1_048_576;
export const NAME_MAX = 80;
export const TITLE_MAX = 200;
export const BRIEF_MAX = 5_000;
export const LIST_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;
export const SECTION_MAX_CHARS = 50_000;
export const CUSTOM_SECTIONS_MAX = 20;
export const SECTION_NAME_MAX = 80;
export const FILE_MAX_BYTES = 50 * MB;
/** The raw upload route reads this much, so a file over `FILE_MAX_BYTES` is a 400 and a body past the window is a 413. */
export const FILE_BODY_WINDOW = FILE_MAX_BYTES + MB;
export const FILES_MAX = 100;
export const FILE_NAME_MAX = 200;
export const COLOURS_MAX = 20;
export const COLOUR_NAME_MAX = 40;
export const HISTORY_MAX = 50;
export const DEFAULT_TIMEZONE = 'UTC';
/** A saved draft, counted in code points after trim. */
export const DRAFT_MAX_CHARS = 50_000;
export const SKILL_PATH_MAX = 4_096;
/** A writing-style retro: at most this many changes per answer, each `text` at most this many code points. */
export const RETRO_CHANGES_MAX = 10;
export const RETRO_TEXT_MAX = 2_000;
/** The retro log keeps the newest failed and "Nothing to learn" retros. */
export const RETRO_LOG_MAX = 50;
export const RETRO_TIMEOUT_MS = 60_000;
/** A failed retro's reason is cut to this many characters. */
export const RETRO_REASON_MAX = 200;
/** A Video tab media file: 2 GiB. A declared size over it is a 400; a body that streams past it is a 413. */
export const MEDIA_MAX_BYTES = 2_147_483_648;
export const MEDIA_FILES_MAX = 200;
/** A media file name, extension included. */
export const MEDIA_NAME_MAX = 120;
export const CHECKLIST_ITEMS_MAX = 30;
export const CHECKLIST_ID_MAX = 40;
/** Label and detail are counted in code points. */
export const CHECKLIST_LABEL_MAX = 200;
export const CHECKLIST_DETAIL_MAX = 1_000;
export const RENDER_TIMEOUT_MS = 30 * 60_000;
/** Post stats snapshots and publishing. */
export const LIVE_URL_MAX = 2_000;
export const COUNT_MAX = 1_000_000_000_000;
export const STATS_NOTE_MAX = 1_000;
/** Average watch time, in seconds (a day); the task set no limit. */
export const WATCH_TIME_MAX = 86_400;
/** A time may be this far ahead of the server clock (clock drift between the browser and the daemon). */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;
export const EXTRACT_TEXT_MAX = 20_000;
export const EXTRACT_IMAGES_MAX = 10;
export const EXTRACT_IMAGE_MAX_BYTES = 10 * MB;
/** The extraction route reads ten full-size images plus text and form overhead, so an image over its limit is a 400 and a bigger body a 413. */
export const EXTRACT_BODY_WINDOW = EXTRACT_IMAGES_MAX * EXTRACT_IMAGE_MAX_BYTES + 2 * MB;
export const EXTRACTION_TIMEOUT_MS = 120_000;
/** An extraction that was never saved or discarded is removed after this long. */
export const EXTRACTION_TTL_MS = 24 * 60 * 60_000;
/** Images tab: a rendered image's width and height, in pixels. */
export const IMAGE_SIZE_MIN = 320;
export const IMAGE_SIZE_MAX = 4_000;
/** Still compositions one `render_images` call renders. */
export const IMAGES_PER_CALL_MAX = 20;
export const STILL_TIMEOUT_MS = 60_000;
export const IMAGES_CALL_TIMEOUT_MS = 5 * 60_000;
/** Thumbnail stills one `render_thumbnails` call renders; their sides and time limits are the images' (`IMAGE_SIZE_*`, `STILL_TIMEOUT_MS`, `IMAGES_CALL_TIMEOUT_MS`). */
export const THUMBNAILS_PER_CALL_MAX = 5;
/** Alt text: one line per image, each counted in code points. */
export const ALT_TEXT_LINES_MAX = 20;
export const ALT_TEXT_LINE_MAX = 1_000;
/** Remotion Studio: the newest log lines kept, each cut to this length, and how long it may take to print its ready line. */
export const STUDIO_LOG_LINES = 200;
export const STUDIO_LOG_LINE_MAX = 2_000;
export const STUDIO_START_TIMEOUT_MS = 120_000;
/** Studio stops when no Remotion tab of the Building has sent a heartbeat for this long. */
export const STUDIO_IDLE_MS = 10 * 60_000;
/** At most one log-only Studio event in this window; state changes are never held back. */
export const STUDIO_LOG_EVENT_MS = 1_000;
/** Insights: the generated document's size, the wait after the last stats change, the agent's time, and the versions kept. */
export const INSIGHTS_MARKDOWN_MAX = 30_000;
export const INSIGHTS_DEBOUNCE_MS = 10 * 60_000;
export const INSIGHTS_TIMEOUT_MS = 5 * 60_000;
export const INSIGHTS_HISTORY_MAX = 20;
/** A failed refresh's reason is cut to this many characters. */
export const INSIGHTS_REASON_MAX = 200;
/** Importing past Concepts: posts one Concept brings, the free text about media kept elsewhere, and the Concepts a session's "Reference content" lists and how much of each. */
export const IMPORT_POSTS_MAX = 20;
export const EXTERNAL_ASSETS_MAX = 2_000;
export const REFERENCE_LIST_MAX = 10;
export const REFERENCE_EXCERPT_MAX = 200;
export const REFERENCE_LIMIT_DEFAULT = 10;
export const REFERENCE_LIMIT_MAX = 50;
/** A line comment sent to the agent's session, counted in code points after trim. */
export const COMMENT_MAX_CHARS = 2_000;
