/** The data fetches and report saves a person can schedule. Kept apart from the code that runs them so the Building type can declare them without importing the SEO runtime. */
export const SCHEDULE_ACTION_LIST: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'sync', label: 'Sync Search Console and Analytics' },
  { id: 'sitemaps', label: 'Refresh sitemaps and check indexing' },
  { id: 'crawl', label: 'Run an internal links crawl' },
  { id: 'indexnow', label: 'Submit new and changed URLs to IndexNow' },
  { id: 'report-weekly', label: 'Save the weekly SEO report' },
  { id: 'report-monthly', label: 'Save the monthly SEO report' },
];
