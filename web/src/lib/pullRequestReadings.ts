import { createPrReadings } from './pullRequests';
import { serverApi } from './serverApi';

/** One reading per Project for the whole app, so the tab label and the PR list share it and it survives tab switches. */
export const prReadings = createPrReadings(serverApi.openPullRequests);
