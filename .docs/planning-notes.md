# Planning notes

House rules for planning sessions on this Project. Read before writing tasks.

## Check before a task is final

These rules already exist below and were still missed, so check each one against the finished task text:
- **Baseline wording.** Never "known gaps is the expected baseline" (10.004 wrote exactly that). Use the wording in [Baseline verification](#baseline-verification) and give the counts. Every bug id named as an expected failure is still open in the bug list: 32.008 named B.016 and B.017, both already fixed, and B.018, which had started passing.
- **Names of new surface.** Notification kinds with severity and subject type, `/ws` events, routes with their status codes ([Cross-process features](#cross-process-features-pin-the-mechanism-names-and-measurements)).
- **Approval and safety gates.** The four points in [State tasks in the workflow-run model](#state-tasks-in-the-workflow-run-model), plus what happens when the workflow already has approval steps.
- **"Existing behaviour".** Each phrase like "per existing limit behaviour" names a function or route that exists today ([Verify current code](#verify-current-code-before-specifying-a-removal-step-or-a-closed-set)).
- **Camera numbers come from code.** A camera angle or bug reference in the task matches `DEFAULT_VIEW` today, or the task says it changes it and names the angle ([Camera angle](#redesigning-the-3d-village-13001-precedent)). The camera-controls task cited bugfix 13.001.004 for a 55-60° Home view while that fix had set 45°; the person had to decide mid-run. The yards task repeated it (brief: "about 55-60 degrees"; code: 45°), so the UI and test plans assumed 57° until Development measured the real view.
- **"Same as X" names the right function and copies its words.** When several modules export the same name, give the module path. A suggested fallback or wording must equal what that function returns, or the task says the difference is intended ([Same as the existing feature](#same-as-the-existing-feature-requirements)). Bugfix 21.001.002 cited `crmMerge.contactLabel` and a `No name` fallback, but the panel uses `crmBoard.contactLabel` with `Contact`; all four steps flagged it.
- **A bug that states a rule lists every site the rule covers.** Grep the feature for the pattern behind the rule and list each hit as in or out of scope ([Controls that depend on an item's type or state](#controls-that-depend-on-an-items-type-or-state-21001004)). Bugfix 21.001.005's display rule ("every CRM time in the Building timezone") covered six UTC sites the task did not list; RCA and its review had to settle the scope.
- **Dependency install is a named prerequisite.** A worktree has no `node_modules`, so every suite fails before any change. 29.002, 36.001 and 36.002 said only "no new failures", and test planning had to flag it; plain `npm ci` also skipped dev dependencies in 36.002. Say "run `npm ci --include=dev` in `server/` and `web/` (the shell may have `NODE_ENV=production`), then a fresh baseline", and word the criterion "no new test failures and no new `tsc` errors": server `tsc` is not clean on `main` ([testing known gaps](testing.md#known-gaps)). 37.006 missed it again: Test Case Planning installed them itself and found 10 timing failures instead of the 2 the last merge reported, so also name the load-dependent cases in [testing](testing.md) as "compare names, pass alone". 37.011, 37.010 and 38.001 named no baseline at all; Test Case Planning installed and measured it (37.010: the same four web failures already in known gaps; 38.001's first registered run failed in 76 files only for missing `web/node_modules`). 38.003 named none either, with 17 `tsc` errors already on `main`.
- **Typed terminal input and shared limits.** A task that types into an agent's terminal follows [Text typed into an agent's terminal](#agent-tools-that-block-typed-input-and-media-files-32007-content-studio-video-tab) (36.002 left it to test planning, and its raw write lost text in bug 36.002.001), and a limit enforced on both sides follows [Code the server and web packages both need](#code-the-server-and-web-packages-both-need) (36.002's plan said the web imports the server file).
- **No mounted-component cases.** A case that clicks, rerenders or relies on state kept between renders needs a DOM, and the web has none ([UI scope](#ui-scope)). Plan it as a pure helper plus a source pin plus a named manual check, or decide in the task to add `jsdom` as a dev dependency. Bug B.032 asked for a rerender test and all three steps flagged it.
- **A bug filed from one failing test lists its whole cause group.** Apply [Tasks that fix part of a failing test set](#tasks-that-fix-part-of-a-failing-test-set): every failure with the same cause, and every assertion in the failing case, not only the one that threw. B.030 named one line of 36.001; line 132 of the same case and sibling `RW-C01` failed for the same reason, and `testing.md` already listed them together.
- **"Fixed by reopening" names the screen a reopen shows.** Before naming the view a bug should switch to, trace what a reopen lands on in code. B.032 said "Quick look / review UI", but a reopen shows Summary with the HTML output, and Quick look (Code/Diff/Docs) depends only on the step's config, so it never "becomes available" mid-round.
- **A bug that reverses documented behaviour names the doc line.** Grep `.docs/` and `docs/` for the old rule and list it for rewriting ([Removing a behaviour](#verify-current-code-before-specifying-a-removal-step-or-a-closed-set)). B.032 reversed `blueprint.md`'s "never snaps the view away" rule, and the task did not name it.
- **Tests over shipped Catalog text.** A criterion that tests a shipped workflow's or skill's wording follows [Tests and the shipped, user-editable Catalog](#tests-and-the-shipped-user-editable-catalog). 38.003's brief asked for it, nobody raised the rule, and the plan added hashes and a field snapshot on top.
- **A decision given as a label is not a decision.** "Budget", "overlap rule", "missed-run policy" each need the rule behind them; see the topic sections for what to state.

## Reworking a project-creation side effect (37.012 new-project setup)

- **Choose the run mechanism in the task.** "Normal path, or a documented exception" left the choice to Development, who first picked the Project's resolved workflow (dropping the fixed `documentation-n-retro-agent` + `maintain-project-context` pairing) and had it sent back in review. For a fixed job, say which: a fixed one-step workflow passed as `options.workflow` (what shipped, `DOCS_BOOTSTRAP_WORKFLOW` in `server/src/projects/plan.ts`) or the Project's workflow. Also state the retry path (a retry from the board uses the Project's own workflow).
- **Name the timing and failure display.** Say whether a delay is removed or kept, whether a failed start shows as `pending`/not started or `failed`, and the function name if it changes.
- **List the tests a new synchronous side effect breaks.** An item created inside `POST /api/projects` appears in every test that creates a project over HTTP and then starts its own task (about a dozen files; use `server/tests/helpers/quietProject.ts`). Grep those callers while writing the task.
- **Dependency install is still a named prerequisite** ([Check before a task is final](#check-before-a-task-is-final)); test planning could not run a baseline here.

## Planning board contracts

For work that changes the Tasks board, specify the observable queue and transition contract before implementation. Storage shape is an implementation choice; this project uses `planningQueueOrder` on planning sessions and standalone items, with `PUT /api/projects/:id/planning-queue/order` for the mixed queue. A reorder must validate the latest complete Planning queue and leave its prior order intact on failure. Nested ready tasks follow `planningGroupOrder`, saved through `PUT /api/projects/:id/planning-queue/sessions/:sessionId/order` with exactly the group's current ready ids; unpositioned tasks follow by `planningRef.task`. The group order never changes numbering, titles, branches, or stacking. Verify mixed ordering, concurrent updates, reload, and write failure in `server/tests/workerManager.test.ts` and `web/tests/taskBoard.test.mjs`.

When manually completing a group with ready tasks, place them in the group's order in the former group slot, retain every unaffected top-level entry's relative order, and persist the children's own slots so deleting the completed conversation cannot change that order. Preserve their provenance. Verify completion, parent deletion, and reload together.

Define planning history categories without overlap: **ready** means unarchived pending; **started** means unarchived, neither pending nor done (including stopped, failed, or blocked); **completed** means done, including archived done; **archived** means archived and not done; **removed** is the session's lifetime created count minus existing linked records. `planningTaskHistory` in `web/src/lib/projectTasks.ts` owns the displayed counts. State any changed category or copy explicitly, and test it against task transitions. These categories read the plan item's own status. The board's columns also count a task as Completed once its WorkflowRun completed while the item is not yet `done`, so a task that reuses the categories next to board wording must say which source wins for that task.

An accepted start or execution queue admission removes a ready task from Planning only after the server accepts the transition. Cancelled or rejected starts leave the exact prior parent and position. An idle session auto-completes after it created a task and its latest ready group is empty; live turns defer that check. Manual completion is a distinct persisted state that archives the conversation, releases ready children without changing them, and restoration makes the conversation resumable while regrouping only currently ready children. Specify these state boundaries, failure behavior, and API conflicts for future changes. A feature that starts tasks from inside a planning session's own view must say what that view and any Back control do when the start archives the session under it (starting the last ready task does); the session's Task still exists, so "return to the session" stays possible. Current routes use `{ error }` with 400 for malformed input, 404 for unknown or out-of-project records, 409 for state/order conflicts, and server failure for persistence errors (`server/src/api/router.ts`). Verify the route status and body alongside server transitions and web live-state behavior.

For grouped Planning interactions, specify keyboard equivalents with focus and announcements. Current controls use the group's dedicated handle for Alt+Up/Down reorder, and task cards use Alt+Up/Down to reorder among their peers (standalone cards at the top level, nested tasks within their own group) or Alt+Right to enter the guarded start flow. A group cannot start. Active or input-blocked groups expand by default, idle groups collapse by default, and an expander toggle lasts for the mounted view. Verify card, handle, and expander separately.

A new card or group kind on the board (precedent: 14.001's bug cards, introducing-task reference cards and bug report sessions; current rules in [Unified Planning board](../docs/unified-planning-board.md#bugs)) needs these in the task, not left to UI Planning:
- **A default-expand trigger that can happen.** Check the state named in the rule against the group's own membership rule. "A group with a running bug expands" could never be true, because a bug leaves its group when its start is accepted; the rule became "expanded while the introducing task is Running or Needs you".
- **Counts.** What the Planning column header counts for the new kind (top-level entries only: a reference card under a conversation counts 0), what the parent's expander says about nested entries of the new kind, with singular forms, and whether they stay visible while the parent is collapsed (they do not; the expander reads "Planning · 1 task ready · 2 bugs").
- **Status words** for each live state of a new session card ("Reporting", "Needs you", none between turns, "CLI not started"), per [Matching an existing control's wording](#matching-an-existing-controls-wording).
- **Announcements as they exist.** A nested keyboard move announces "Moved task up within its planning group." and nothing else: there is no boundary announcement and no "position N of M" (`groupMoveAnnouncement` in `web/src/lib/bugs.ts`). Ask for more only as new behaviour, never as "the same wording as nested planning tasks".
- **Numbers and labels the person sees.** Do not write "Development picks the numbering". Ask the person, then state the scheme for every case: with a numbered parent, with no parent, with an unnumbered parent, nested under another record of the same kind, after a delete (reuse or not), after the parent changes (renumber or not), and whether the branch name carries the number.
- **Every consumer of a shared filter.** `buildPlanningRows` hides bug report sessions unless `includeBugReports: true`; 14.001 added the kind and the footer Sessions count and popover (`openPlanningRows`) kept the default, so they silently omitted it. A task that adds a kind must grep the callers of the helper that filters or counts the board (footer counts, popovers, notifications) and say, per caller, whether the new kind appears, plus the wording that changes with it ("planning" labels become "sessions").
- **Config the web store does not hold.** A preselection that depends on Building Type slot configuration (the "Fix a bug" slot's workflow) must name where the web reads it and what shows until it arrives; the store has no Building Type config.

## Building tasks that leave behaviour "open" (32.001 Content Studio precedent)

Planning left ten contract choices open and each was decided later in Test Case Planning and Development. For a new Building type, state these in the task:
- **Defaults and wire forms.** Timezone omitted at create (default `UTC` or 400); date wire form (ISO instant with `Z` or an offset, never local text); whether a zone alias is accepted (spelled as `Intl` lists it).
- **Which fields can change.** Say which record fields are immutable after create (post platform/format), which built-in items cannot be deleted (built-in knowledge sections), and the status for a wrong-state transition (409).
- **Duplicates and sizes.** Duplicate upload name (409), the number for "the route's body window" (limit plus 1 MB headroom), and the week start of a calendar (Monday).
- **Raw uploads must not depend on the client's Content-Type.** The app-wide `express.json` parser runs first, so a `.json` brand file was swallowed. The client always sends `application/octet-stream`, and the server skips the JSON parser for that route; say so in the task. The CRM MOM upload still has this latent issue.
- **Files agents edit.** Say how an on-disk edit by an agent reaches history (here only at the next web save, no watcher) and that there is no atomic check-and-write.
- **Functions with no route yet.** If a later task owns the route (asset state changes), say tests call the store function directly.
- **Adding a Building type changes `buildingApi.test.ts` I1** (the registered type list); say it is an expected spec edit.

## Web tasks built on a finished server task (37.005 Thumbnail tab precedent)

The task text was written from the feature idea, not the shipped server, and three steps had to settle the differences. State these in the task:
- **Name the real route and body.** Open the server file (`server/src/content/thumbnailStudio.ts`) and write the actual routes, DTO fields and request bodies. 37.005 asked for a "choose-final" route that does not exist: the pick travels as the Finalize body `{file}`, and `contentApi.studioAction` posted `{}` for every action. Say whether the choice is local state, what clears it (new round, reopen, fewer variants, tab switch) and whether a single variant is preselected.
- **A shared component the spec needs to behave differently gets a decision.** If a spec line conflicts with a shared component (37.005: "Start a new session" on the finalized view, while `paneButtons` in `StudioPaneView` hides it), say whether the shared pane changes and how, by default an opt-in prop so the other tabs stay unchanged, and name the server rule it must respect (a finalized asset refuses a new round, so the pane sends Reopen). Add a case that pins the other tab's unchanged markup.
- **List mirrored copies.** A web tab or rule list that has a server mirror (`CONCEPT_TABS` in `server/src/content/rules.ts`, pinned by `server/tests/contentRules.test.ts`) is named as a server edit even when the task is labelled web.
- **Do not plan cases the harness cannot run.** The web has no DOM harness: no mounted-component cases (unmount, double-click timing), and the store ignores events by asset id, not by Building. Put such behaviour in a pure helper (37.005's `singleFlight`) and plan the case against that, or list it as a manual check. Plan against what the "if the server exposes it" parts already ship (the Publish dialog row existed since 37.004).
- **Mockup vs shipped server.** Check each mockup element (zip link, preview image, size line, custom badges) against a route or DTO field before UI Planning is approved; drop or list what has none.

## Specifying a feature that adds server routes, a payload field and an approved mockup (37.007 precedent)

Test Case Planning and Development settled these because the task text left them open. State them in the task:
- **Every route and body.** A way to clear a value (here `DELETE settings/speaking-speed`, since `PATCH` refuses `null`), the nested payload shape, list and delete routes for any row the UI shows, and the field named in each 400.
- **Input edge rules.** Whether a count is a whole number, and what happens to values that are not safe integers (refuse, naming the field, before any rate check). Say whether a computed average is clamped (it is not).
- **A mockup element needs a data source.** The approved footer button showed "(142)", but while a manual value hides the average the API has no detected number. Check each number in a mockup against a payload field, and decide whether undo exists (no restore route means no Undo toast).
- **Mockups come from the UI step.** A read-only UI Planning round 1 delivered no HTML. If outputs are required, say the step must attach them; otherwise state the plan is text only.
- **Test fakes and aborts.** A task that deletes something while a fake process runs says the fake must handle an already-aborted signal (see [testing](testing.md#known-gaps), 37.007).

## Baseline verification

Before claiming a baseline, check package dependencies and registered test actions, then run the commands in [testing.md](testing.md) in an environment that permits them. A missing binary or forbidden temporary-directory write is an unavailable baseline, not a product-test failure. A shell with `NODE_ENV=production` skips dev dependencies, so the setup step says `npm ci --include=dev` in `server/` and `web/` (37.002's baseline was unusable until then). Make dependency setup and a fresh run of every configured check an explicit prerequisite for the writable coding stage. If checks still fail after setup, record the exact failures and resolve them separately or get an explicit acceptance decision; do not silently lower the task's verification standard to "no new failures." Do not infer a pass or coverage threshold from a read-only planning stage or an absent `.docs/testing/config.json`. Failures already known on `main` are listed under [testing known gaps](testing.md#known-gaps), but that list goes stale when a task lands failures without recording them. A planning session cannot run the suites, so word the task's baseline as "the failures of a fresh registered run on the starting revision; known gaps is the expected list, and any difference is reported before coding", not as "known gaps is the baseline". Give the counts from known gaps (web and server separately, including the server `tsc` error count from [known gaps](testing.md#known-gaps), 17 on `ca01d3d`) so a mismatch is obvious. Since `8829494` both registered suites are expected to have 0 failures, so a nonzero count is the mismatch to report. Do not copy failure names into the task: 8.001 named four failures while known gaps already listed the seven `statusFooterStore` cases and an intermittent `workerManager` one; 32.006 named B.016 to B.018 while B.018 already passed and the failing B.019 was left out. Link the known-gaps section instead. The baseline is a run through the `agent_visual_os_tests` tools, not a shell `npm test`: the registered runner's environment makes one more server test fail every time.

When a task says tests must not use real account credentials, also say whether a one-off manual check with the real CLI or account is allowed during development, and who does it. Without that, behaviour only a real session can show (8.001: what `claude --resume` does to the session id and file) stays unverified and must be listed as a limit in the product doc.

The read-only test-case planning step cannot run a baseline, so the baseline run belongs to the first writable step and the task must say so; otherwise a failure missing from [testing.md](testing.md) (task 10.001's `terminalSessionManager`) cannot be classified as new or pre-existing. Phrase the criterion as "no new failures beyond the known-gaps list". The registered `server` run can hang until its 15-minute timeout (see [testing.md](testing.md#known-gaps)); a task that needs a server baseline names the fallback, a direct run on a clean checkout of the starting revision, so the first writable step does not have to invent it.

**Build errors and the tests they hide.** The baseline includes `tsc -b` in each package as well as the suites. A test file that fails to import because of a build error hides its own failures: after any proposed build fix, run those files before promising they pass (the yards task's fix exposed `cameraMath` U33, now bug B.018). Grep the known baseline failures for the symbols named in the build errors; a failure that shares the cause belongs in the same fix. The yards task scoped the `TOWN_HALF`/`ROAD_LINES` build errors but left `villageTerrain` U42, which bans those names, as "not this task's", so Development re-added a banned name.

## Daemon-backed popup data

For a Project popup control that reads changing external data through the daemon, settle the response and lifecycle contract before implementation: distinguish a real zero from unavailable data; define missing-Project and missing-integration responses; specify when the popup fetches, what is cached and for how long, how failure and manual Refresh interact with that cache, whether concurrent requests coalesce, and what count and last-checked time appear while a replacement is pending or fails. Include approved UI-planning amendments in the task's acceptance criteria before deriving tests. For the pull-request tab, the current contract and implementation pointers are in [blueprint](blueprint.md); verify daemon failures with a fake `gh` and client timing with an injected clock (`server/tests/openPullRequests.test.ts`, `web/tests/pullRequests.test.mjs`).

For a list view fed by such a control, also settle these before Development: the response and row field names and the list cap with a `truncated` flag; the tie-break for equal timestamps; whether a failed refresh is cached or retried on the next open or poll; whether a failed refresh keeps its error visible while the retry loads when there is no data; whether a manual Refresh joins a request already in flight; whether polling and visibility changes force a fetch or use the cache; and whether a response still in flight for a replaced setting is dropped. Task 10.001 left these to Development and Code Review (the choices are in [blueprint](blueprint.md)); the error-while-retrying case is still open (the error clears at each poll when no data is held).

Where a setting for a new option lives (a new section or an existing one) is a UI Planning decision to record in the approved mockup, not to leave under "Where to focus".

## Actions that write to the Git provider or switch the working copy

Precedent: 10.002's Check out, Return and Merge (current rules in [blueprint](blueprint.md), "PR tab actions"). The read-side rules above do not cover writes, so the task must also give:
- **Route contract.** Each route and body, the status per refusal (409), bad input (400), unknown record (404) and provider failure (502), and the body of a partial success (merged but branch not deleted is 200 with a warning field, never an error).
- **Every local-branch state** for anything that switches branches: absent, at the target commit, behind, ahead only, diverged. For each, say switched or refused. "The person is told and nothing is overwritten" does not say whether the folder still switches (10.002: diverged is refused, ahead-only is switched and kept).
- **Remembered state.** What "previous branch" means after a second checkout (the branch current just before the latest one), where it is stored (the Project record, so it survives a reload), and what clears it (an ordinary branch switch or creation).
- **Fork pull requests**, for every operation: the local branch name when the fork's branch name collides with a local one (`pr-<n>/<head>`), where a push goes and what happens when it is refused, and whether "delete the head branch" applies (no).
- **Provider behaviour stated as fact.** Check it against the provider's API documentation, or mark it "unverified, Development confirms". 10.002 assumed GitHub retargets a stacked PR when its base branch is deleted; deleting through the API closes it, so the daemon now retargets first.
- **Clean-up after a write is defined by its end state.** For each follow-up call (delete the head branch, retarget a stacked PR), say what the provider answers when the end state already holds, and that this is a plain success. Give each call its own failure rule; one "any failure warns" rule for several calls hides the difference. 10.002 specified only "merged but branch not deleted warns", so a branch GitHub had already removed ("Reference does not exist") warned on every merge until 10.002.001.
- **Overrides.** "Attempts the merge anyway" needs its mechanism named (`gh pr merge --admin`), which blockers it applies to, and that an unconfirmed or automatic merge never uses it.
- **Asynchronous provider state.** How long to wait for a recomputed value after a write, and what a still-unknown value means when the wait ends (a blocker, never clean).
- **Per-row state the list call does not carry.** When each row re-reads it (10.002: when the PR's `updatedAt` changes, on Refresh, after an action, on a run status change), and that the daemon re-reads at click time.
- **Mutual exclusion.** Which actions refuse each other as busy, per Project and per record, and which are not blocked by a busy Project folder (merging is not; Check out and Return are).
- **Real-CLI checks.** Fakes cannot show provider field names, CLI argument forms or timing. List the manual checks with an owner and say whether the task may be accepted while they are open. 10.002 finished with all of them open.

## Building Types and storage contracts

Precedent: 10.003 (current rules in [blueprint](blueprint.md), "Building Types and the bulk data layer"). A task that extends the Building contract or its storage must also give:
- **Closed option sets.** Every enum-like contract option with its allowed values and meaning (10.003 left `onConflict` open, so a half-built `replace` appeared and was removed; only `fail` and `ignore` exist).
- **Error classification.** Which storage errors are faults that stop a Building's ingestion (disk full, I/O, read-only, corrupt) and which are the caller's data errors (constraint violations: 409 for that request, ingestion keeps running).
- **Reconcile approved UI with the task text.** When a UI round changes what is configurable (10.003: per-step agents replaced per-role agents), edit the task's wording and acceptance criteria in the same round. Say whether any declared role stays unconfigurable.
- **What a skeleton or secondary type needs for platform features.** If every type gets the Tasks board, say the type's popup must include a Tasks tab.
- **Name only things that exist.** Check that a test case's helper or function can exist in the run model (a planned `workflowStepsFor` hiding commit, push and PR steps could not: those are the implicit Complete stage).
- **Unique case ids.** Test-case ids must be unique and the stated count must equal the list.
- **Read-only and error codes, pagination limits, flag names, and the baseline** are stated in the task (existing rule: 409 for read-only; default 50, max 200, clamp; `AGENT_VISUAL_OS_DEV_TYPES`; baseline per [Baseline verification](#baseline-verification)). Node has no `.nvmrc`; the engine choice records the checked version.

## Heavy data, benchmarks and external APIs (10.006 SEO Building)

A task that stores bulk data or calls an external API must also give:
- **Benchmark budget.** A full 10M-row run can take over an hour. Say the time budget and the accepted proxy (a sized-down run with extrapolation, or the full run on the owner's machine) and that an unfinished run does not meet the criterion. Name what the benchmark must measure (ingest rows/s, list and aggregate p95, event-loop lag).
- **Raw rows versus roll-ups.** Whether raw rows must be sortable by metrics or rankings may come from roll-ups. Extra indexes on a large raw table slow ingest sharply; default to roll-ups for rankings.
- **External API version and verification.** The API version to target, who checks it against a live account, and the wording for an unsupported version. Which vendor field marks "exact" versus "range", or that no such field is confirmed.
- **Refused upstream calls.** The status code when a third-party call is refused (502 upstream failure, not 409).
- **Code-running schedules.** Whether the platform scheduler can run code or only agent workflows; if only the latter, say how daily sync runs.
- **Contract choices to pin, not assume:** URL length limit, window bounds, status for an unconfirmed destructive action (409), whether a fetched-empty day is zero or a gap, the vendor's date time zone, omitted versus null fields.
- **Read-only steps.** A read-only step never writes project files, but its `complete_step` outputs are not files: mockups go inline in `outputs[].content`. A step with `requiredOutputFormat: "html"` (UI Planning) cannot complete without one.

## Jobs that start runs on their own

Precedent: 10.004 (current rules in the [scheduler contract](../docs/scheduler.md)). Its task listed guardrails by name; about thirty choices were then settled in UI planning, test planning, development and review, and one (the approval gate) was built wrong first. A task that adds or changes automatic starts (schedules, polls, triggers, retries) gives each point below, or says "Development picks it and records it in the product doc":
- **Each guardrail as a rule.** What is measured and from which stored data, what a blocked start becomes (skipped, queued, deferred or failed), whether that survives a restart, the order the guardrails are checked in, and whether a manual start obeys it. Check the data exists first: "per-run budget" named nothing, because the app holds only an agent's 5-hour and weekly usage percentages.
- **Where an approval gate sits.** An approval step pauses after it has run, so "before publishing" means the step before the outward-facing one becomes the gate. Say what a one-step run does and what happens when the workflow already ends in an approval step (now: it pauses twice).
- **Which run states count as failed.** A run whose step fails becomes `needs-attention`, not `failed`. Anything that counts failures, retries or turns itself off says which states are failed, stopped and still going (see `runStateOf` in `server/src/scheduler/runStarter.ts`).
- **A Building with no repository.** Its cap is one, and its folder stays held while a run needs attention or approval. Say whether a start that cannot begin waits or fails, and whether it counts toward any failure limit. Still undecided for the scheduler: it waits, so the job never turns itself off.
- **Grammars and bounds.** The dialect of any expression (cron fields, names, macros), selector syntax (JSON field path), minimum and maximum of every number and text field, retention count and page sizes.
- **Reads of outside sources.** Allowed locations and addresses, method, headers and credentials, timeout, size cap, what the first reading does, what counts as a change, what a failed read records, whether a repeating error is recorded again, and whether it counts as a failure.
- **Time.** Where the timezone is stored and its default, which calendar day a daily count uses, the daylight-saving gap and overlap rules, several missed slots at once, a restart that crosses a slot, and a wake from sleep without a restart.
- **Defaults a Building Type declares.** The fields the declaration needs, when Buildings get their copy (existing Buildings included), whether a copy can be deleted and how it comes back.
- **Shared code the task must change.** Name it when the behaviour needs it (10.004 changed the failure text of every Task in `settleFailed` and made malformed JSON answer `{ error }` on every route), so tests that pin the old behaviour are found before coding.
- **A new job target kind (28.001 saved command).** State, per guardrail, whether it applies to the new target (concurrency cap, overlap, daily limit, needs-approval, usage gate) and what the server does with a value sent for one that does not apply (refuse it, or store and ignore it). Give the field-error keys, the run-id prefix, the status-to-state mapping and the exact failure note for each outcome, including a start that fails before any exit code exists. 28.001 left the last two and the ignored-field rule to planning assumptions.
- **"Optional" means a named threshold.** An optional extra ("a Schedule… menu item, skip it if it needs more than light wiring") says which cases count as heavy, for example "needs a new store field or changes more than two files", or is decided now as in or out. Otherwise Development guesses and the matching planned test case is dropped.
- **Answer the UI step's "Decision needed" items in the task.** Open questions a mockup raises are written into the task text when the mockup is approved, not carried as assumptions into test planning.

## Measured history and estimates

For a feature that samples, stores or compares measurements (precedent: 8.001, current rules in [agent analytics](../docs/agent-analytics.md)), give each value below in the task, or write "Development picks it and records it in the product doc". Left open, each one becomes a test-planning assumption.
- **Thresholds, tied to the sampling interval:** what counts as a gap (now two intervals plus a minute, so one skipped sample does not break the line), stale (15 minutes), how near a boundary reading must be, and any tolerance for jitter or resets.
- **Manual Refresh against the schedule:** how soon after a scheduled success it may check again (one minute), and what it returns when it may not (a success carrying the last reading and the next eligible time, not an error).
- **Observation time** when the provider returns none (arrival time), and the key that makes two observations the same one.
- **Which sessions count:** the background session kinds by name, whether a waiting session counts as overlapping work (no: working time only), and sessions the daemon cannot see (reopened inspection sessions run with hooks off).
- **Records from before the feature:** whether they appear, how they are marked, and whether they feed a median (they appear as approximate and feed none).
- **Unknown values on the wire:** `null` with a reason, never omitted and never 0; and what a provider field outside the app's existing shape maps to (the Codex reader in `server/src/analytics/cliUsage.ts` takes input, cached input and output only).
- **Comparison rules:** the group key and its case sensitivity, what "earlier" means, the median of an even count, and whether a threshold is inclusive.

## Charts and new top-level views

Before writing chart ranges into acceptance criteria, work out how many points and overlays each range draws. Five-minute samples are 288 a day and about 26,000 over 90 days, so 8.001's 24h/7d/30d/90d ranges with activity bands were rejected in UI Planning for one day at a time with a date switcher. If the density is not clearly readable, state the outcome ("inspect any retained day's readings") and leave the range design to UI Planning. When an approved mockup replaces a criterion, restate that criterion in the task before tests are derived.

For a new view, also say:
- its container (centred dialog, side sheet or page; see [UI scope](#ui-scope)) and what it leaves untouched underneath;
- where an item's details show (hover box, side panel or table row) and what a click does;
- whether an existing display changes when the new view shows the same value another way. The footer still shows percent used while Analytics shows percent remaining, with both figures side by side in the view.

## Session-scoped agent tools

When a task gives agent sessions new tools (MCP servers), the task must state:
- **Which sessions get them**, by session kind: execute Tasks, planning sessions, and WorkflowRun steps. Steps run their own Tasks and are split by `canEditCode`, so say whether writable steps, read-only steps, or both count.
- **What "active" or "stale" means** for authorization, in terms the daemon tracks: Task status (`developing`, `blocked`, ...) and membership of the Project's `activeTaskIds`.
- **What the read tools may see**: only the calling Task's own records, the whole Project, or both. Cross-Project access is always refused.
- **Validation contract for capped/optional fields**: when the tool caps a count or a text length "so a runaway agent can't flood" something, state what happens on overflow — reject the call, or silently truncate/clamp. When every field is optional, state whether a call giving none of them is valid (a no-op "I'm still here" ping) or must be rejected.
- **Wire contract.** Give enum values exactly as sent (lower case, case-sensitive, no normalising), a limit for every text field including ids and commit, whether a limit counts the text sent or the text stored after the daemon wraps it, and one status per refusal: bad token 401, wrong session kind or stale caller 409, unknown or other-Project record 404, a record the caller does not own 404, a record past the editable state 409. Never write "400 or refused". When the daemon adds headings or ids around the caller's text, the caller's limit must be smaller than the stored limit (14.001: a coding agent's description is 18,000 so the composed text fits 20,000; review found the mismatch).
- **Dedupe keys.** Which fields, exact or case-insensitive, trimmed or not, the scope (one Project), and which existing records count as a match (open only: not completed, not archived).
- **Paired optional fields.** When one field only has meaning with another (a commit with its introducing task), say what happens when it arrives alone (dropped) and when the other changes (the old commit is dropped unless a new one is sent).
- **"Same rule as X" plus an explicit condition.** If the task says both, say which wins where they differ. 14.001 gave `report_unrelated_test_failure` "the same rule as the testing tools" and also required a `developing`, active caller; a session reopened for inspection gets the testing tools but may not file.
- **Tools that create a second record kind (14.0xx report sessions filing tasks).** Name each field the underlying record lacks (e.g. plan items have no priority: drop it, say the server ignores a stray one), the text limits and whether overflow is refused, which fields are required, and how the session marks its own records (an owner field holding the session number). State how a link to another record is stored (snapshot copy or live lookup; a rename does not update a snapshot) and which records it may point at.
- **"Has not started" for edit/delete.** Define it as a list of signals (status, runs, `taskIds`, `workflowRunId`) and say whether a pending record still waiting on parents counts (it does not: still editable). Say what each wrong-kind id gets: 404 for foreign or manual records, 409 for a bug id sent to a task tool and the reverse.
- **Counts and wording once a session owns two kinds.** State whether auto-complete counts both kinds, the card line and panel label wording ("N bugs ready, M tasks filed"), and on which board columns link lines show (open cards only).
- **Tests that need the planning lock.** The lock is not reachable from tests, so a start-versus-update race can only be tested in sequence; say so in the plan instead of listing it as a case.
- **Stray working-tree files.** Say that unrelated tracked changes (e.g. `.claude/scheduled_tasks.lock`) stay out of the task's commit.

Current precedent (tasks 2.004, 2.005): the testing tools go to execute Tasks and `canEditCode` steps, never to read-only steps, because running a test action runs project commands; "active" means `developing` and in `activeTaskIds`; `get_test_run` reads any run in the same Project. For the validation contract (5.017, `report_progress`): reject-with-400 on both overflow and an all-absent call, matching `complete_step`'s existing strict-validation convention for `summary`/`verdict`/`planningGap`. Leaving either choice unstated forces Test Case Planning to guess the test expectations and Development to decide alone mid-build.

## Starting a session when no agent is available

Do not copy "the same refusal as Plan" for a new session-start dialog without asking the person. For Report bug (14.001) the person wanted the description kept: the session is created with no CLI and started later from its own screen, while Plan keeps its refusal. For a record that can exist before its process does, the task states: where the typed text is stored (on the session, on the daemon) and until when it is editable; when the number is taken (at creation); that it holds no concurrency slot; whether it can be completed automatically (no), archived or deleted by hand (yes); what its tools answer (409); the route and status for each of create, edit and start (unknown agent 404, non-CLI agent 422, already started 409); and that it survives a daemon restart without being marked failed. A `TaskRecord` field that decides what a session is must also carry over to the Task that every resume and follow-up creates ([blueprint](blueprint.md), Bugs).

## "Same as the existing feature" requirements

When a requirement says new behaviour must match an existing feature ("updates the same latest results", "same events as a manual run"), check that feature's current rules in `.docs/blueprint.md` and the code first. If a rule would make the new case behave differently (for example, latest Test Results count only runs on the primary working tree, so an agent run in a worktree never becomes a latest result), the task must say whether to keep that rule or change it.

Read the code path the phrase points at, and name the function, before writing "as the existing X does". Task 10.002 asked Check out to do "task branch retargeting as the existing branch switch does", but `checkoutProjectBranch` in `server/src/projects/projectService.ts` retargets only when it creates a branch (uncommitted work moves with it); a switch to an existing branch retargets nothing. Development built the retarget, review removed it because a resumed paused task would then commit onto the PR's branch. The same task described the agent picker as "the Start task dialog's list" while also wanting limit-reached agents selectable, which that dialog hides. If the existing feature does not do what the sentence says, write the wanted behaviour out in full.

## State tasks in the workflow-run model

Every task runs as a WorkflowRun: its own worktree and branch, runs in parallel, steps split by `canEditCode`/`requiresApproval`, and work committed and pushed per write-capable step. A spec written for the older single-Task model ("the Task blocks for input", "a dedicated approval unlocks the same session", "queues behind another task") must be restated in these terms before work starts. For any approval or safety gate, the task must say:
- which step is read-only and which step is the gate, and whether the workflow is the Project's own or a dedicated one;
- which action records approval (existing approve/request-changes/stop or a dedicated route), and what exactly it covers (for example, a specific proposal round);
- what happens to commits already on the run's branch when a later round is rejected or loops back (the engine commits a write step's work before it evaluates a loop);
- whether a retry reuses the existing approval or goes back to the gate.

For a run that a button outside the Tasks board starts (10.002: Merge on a conflicting PR starts a conflict-resolution run), also say:
- who picks the agent and when. The person expects to choose one before any task is created, so specify the dialog, what is preselected, which agent kinds may run it, and whether Retry asks again (10.002 lost a UI round to this; it now asks every time and lists every configured agent);
- whether the run counts against the Project's concurrency cap and the plan-item queue. "Does not queue" covers only the queue;
- which board column a stopped or failed run sits in, and where its Retry lives (PR tab only);
- what happens automatically when the run ends and what still waits for the person (conflicts resolved but other blockers remain: nothing merges until confirmed).

## Workflow engine changes

When a task changes how rounds, loops or approvals run, state the behaviour per step role, not only for the named example steps: the loop target (fix step), the loop origin (reviewer), steps between them, the approval step, and any step between a Request changes target and its approval step. For each, say what the step receives and whether it must see the person's comment. Also say:
- whether testing setup runs (`server/src/testing/setup.ts`) are included in a generic rule, since their proposal and implementation steps are a loop target and origin;
- how the loop budget counts rounds after a routing change (`evaluateLoop` counts every round of the loop step in the run);
- how any external state is detected and what happens when detection is wrong (5.006: a CLI session is "resumable" only if its file is found on disk, and the config dir comes from `CLAUDE_CONFIG_DIR`/`CODEX_HOME`);
- the contract for a new Workflow field: absent vs null, which step kinds may set it, the 400 error text, and what the web form does when the referenced step is removed or reordered.
- the contract for a new start or run option (5.007's `skippedStepIds`): its field name and meaning (selected or left-out steps), what absent means, whether the server re-validates what the dialog enforces, and whether rules between steps (a step depending on its loop target or Request changes target) apply transitively.
- which entry points carry it. The Start task dialog (`POST /api/plan-items/:id/execute`), `start-when-ready` and testing setup all share the slot-gated waiting list ([blueprint](blueprint.md)): a start at the task limit queues with 202 instead of failing. Say which options the queue entry stores (`PlanItemQueueEntry` has no `autoMerge`; it is saved on the plan item) and that a new option must be carried by the entry and replayed by `advanceQueueLocked`.
- whether a continued round's resume/rerun prompt (`buildReviewFixMessage`/`buildChangesRequestedMessage`/`buildRerunMessage`) needs to remind the agent of a per-round instruction that doesn't carry over, since these prompts send only what's new rather than the full step briefing. 5.017's progress checklist resets to empty on every new round (loop-back, Request changes, retry, resume); the task left whether to nudge a resumed round to re-post it unspecified, and Development had to decide alone (it chose no reminder, matching these prompts' existing convention of not repeating `complete_step`/`skip_step` either).
- for a change to how a manual recovery action (Retry, resume) starts its round, list every run state that offers the button and say what happens in each (5.006.001 treated every needs-attention Retry alike and the RCA review had to add two). Needs-attention also happens while the step's session is still live (a pending question: say whether it is stopped first or the action is refused) and after a round that already finished (a loop out of rounds, a read-only step that changed the tree: resuming a finished session makes no sense). Also say what the fallback keeps from today's path (the regression reasons a fresh round appends), and grep the docs for the old behaviour used as a recovery path (`.docs/blueprint.md` "Later-round limitations" relied on a fresh Retry to escape a session that passes the probe but fails to resume).
- for a change to what prompts carry, list every prompt builder (`buildStepPrompt`, `buildRerunMessage`, `buildReviewFixMessage`, `buildChangesRequestedMessage`, and the full briefing a non-resumable round appends) and, for each one, whether it carries that content today and whether the task adds it. "Wherever outputs appear" in 5.020 left Test Case Planning to guess whether review-fix and Request changes messages, which carry no outputs, should start carrying them. The answer was no.

## Per-task data that must work before a run exists

When a task says a feature works for "executing or idle" tasks, an idle task has no WorkflowRun, so no workflow snapshot to validate step ids against and no run view. The task must say: where the data lives (on the `PlanItemRecord`, keyed by step id, as per-step notes do), how ids are validated before and after a run exists, what happens to entries for steps the chosen workflow lacks, and which screen the person uses when no run exists. The per-step notes task (the "Add per-step instruction notes" task) left the last one open: the API accepts notes for idle tasks but only the run view has a control, so the idle case has no UI. Either name the idle-task screen or state "run view only".

Also state, for any text the person leaves for a later session: its lifetime (use once then clear, or persistent), a length limit and how it is counted (code points on the trimmed text), and which prompt builders carry it (see "Workflow engine changes"). Pin edge handling in the spec: `null` clears, a missing field is 400, inner newlines are kept.

## Code the server and web packages both need

`server/` and `web/` are separate packages: `web/src` cannot import `server/src` (web tests can, which is how parity tests work, so a test importing a server file is no evidence the app may). If a rule (a limit, a counting function) must hold on both sides, the task should say "duplicate it and pin it with a test that imports both and compares", not "use one helper". Test Case Planning's "one helper for server and web" could not be met and cost a review point.

## Tests and the shipped, user-editable Catalog

`catalog/workflows/*.json` (and the Catalog's agents and skills) are the person's own configuration and change on purpose. Never plan a test that reads them or asserts their steps, ids, approval targets, Quick look values or wording (the B.001 cleanup removed about 12 such tests). Plan engine tests on inline or fixture workflows (`server/tests/fixtures/catalog`; `server/tests/fixtures/notes-workflows` for the Notes Building). A new fixture workflow goes in its own directory unless every test that copies `fixtures/catalog` still passes, because `workflowApi.test.ts` asserts the exact workflow list.

One exception, only when the brief asks for it: a generic referential-integrity check over every shipped workflow (each step's `skillIds` resolve to an enabled Catalog skill; each `preloadSkillIds` entry is in `skillIds`), as in `server/tests/uiDesignSkill.test.ts` (29.001). It reads no step list or wording. Do not plan tests that assert one shipped step carries a given skill or begins with a given sentence (29.001 U20/U21 did); check that once in review instead.

**The 38.003 exception and its cost.** `server/tests/workflowInstructions.test.ts` reads `catalog/workflows/software-development.json`. It pins phrases in UI Planning, Test Case Planning and Development, SHA-256 hashes of Code Review, Docs & Retro and Test Case Planning's numbered list, and every non-instruction field of every step. The brief only asked that the three steps "contain the items above"; the hashes and the snapshot came from test planning. So any later edit to that workflow, including a retro's `update_workflow_step` on the live Catalog, fails the suite until the test changes. When a brief asks to test shipped Catalog text, raise this rule in the interview, settle the narrowest check (the new phrases only, or a fixture copy), and write into the task that later edits to that workflow update the test.

## Tasks that edit planning prompts or shipped Catalog step text (38.003)

- **Name the sibling steps, do not say "where it fits" (39.001).** When a step change should reach similar steps in other workflows, list them by workflow and step id (39.001: `bug-fix.json` `bugfix-review` yes, `rca-review` no, since it reviews a report). Test Case Planning and Development each had to guess.
- **A brief that edits pinned Catalog text says what happens to the pins.** `workflowInstructions.test.ts` pins hashes and step structure; say they are replaced by text assertions, not re-hashed. State that when the brief itself asks for wording tests (an explicit brief overrides [Tests and the shipped, user-editable Catalog](#tests-and-the-shipped-user-editable-catalog)).
- **A test target must be reachable.** Before writing "extend the X tests", check X is exported or has existing tests. `resolveStepPermissions` (`server/src/worker/workerManager.ts`) is private and decided from step flags alone; its shape is covered through `terminalSessionManager.test.ts`, `workflowPrompt.test.ts` and `reopenStepSession.test.ts`. Name those files, or say no new permissions test is required.

- **Quote live-only Catalog text word for word.** Retro `update_workflow_step` and `update_skill` calls write to the live Catalog in the main checkout as uncommitted edits, so a branch's `catalog/` file can lack them. When a task edits shipped workflow or skill text, read the live file in the main checkout and put any text `main` lacks into the task word for word, with whether it ships. The main checkout can change before Development runs: in 38.003 it was clean by then, and Development recovered the text from the Test Case Planning transcript.
- **A skill the task names exists in the Catalog, and the session loads it.** Check `catalog/skills/` and the session kind first. Planning sessions load no Catalog skills. 38.003 named `grilling`, which lives only in a personal folder, and its "whole frontier per round" clashed with the brief's "one decision at a time"; the owner chose to write the rules into the prompts (`server/src/projects/planningInterview.ts`).
- **Say what a "check it yourself" session can run.** Planning sessions have Bash denied (`PLAN_DISALLOWED_TOOLS` in `server/src/projects/plan.ts`) and only read files; a workflow step can run commands only with `canRunCommands`. For a planning session, "check the baseline" means reading `.docs/testing.md` known gaps, this file and the package scripts.
- **A Plan & bugs rule says whether it covers bugs.** Name tasks, bugs or both, and how the rule meets "a thin report is still filed". 38.003 settled both, with a thin bug filed after the confirmation round.

## Agent session file access

A task that says "check what the sandbox gives" for one CLI (29.002: could Codex's sandboxes Read an absolute path outside cwd?) leaves a claim no test can prove. Name the real-CLI manual check in the acceptance criteria and who runs it; do not leave the finding to Development's reasoning.

When a task grants or restricts agent access to files outside the working directory:
- State the guarantee for each CLI (Claude, Codex) and each autonomy setting. Then say whether best effort is acceptable where no flag can enforce it. Claude's Bash tool and Codex with its sandbox bypassed (auto autonomy) can write anywhere the user can, so in 5.020 "not writable by sessions" could only be enforced by Claude deny rules, Codex sandbox roots and a `0444` file mode. Planning should say up front whether that is enough.
- Name a manual check with the real CLI in the acceptance criteria. Argument-list tests don't prove that a CLI accepts a rule, merges a repeated flag, or reads without prompting ([testing](testing.md#known-gaps)).
- Pin the folder layout and file naming if downstream steps or the person depend on them. Otherwise say they're Development's choice. The current layout is in [blueprint](blueprint.md).

## Retention and deletion

When a requirement says something lives "as long as the task exists", name the record whose deletion removes it. Deleting a task removes the PlanItem (`deletePlanItem`, `DELETE /api/plan-items/:id`). It doesn't delete WorkflowRun or StepRun records, and an item can have runs from earlier attempts. Also say whether a start that is rolled back and Project deletion clean up too, and whether a failed cleanup blocks the deletion. In 5.020 it doesn't: the failure is logged.

## Tasks that fix part of a failing test set

When a bug lists failures that depend on another open bug (B.002's quick look test needed the missing `human-code-review` step), say in the task whether that group waits for the other bug, stays failing, or has its test changed. Default: leave the test unchanged, never weaken it, and state in the expected result which failures remain ("11 failures drop to 1"). Name the other bug.

Before settling a bug's scope, group the whole fresh failure list and [testing known gaps](testing.md#known-gaps) by cause (the commit that broke them, or the shared module they test), and put every failure with the same cause in the task. B.011 named U35b and WU20 only; the `taskBoard` "columns are filled from the existing grouping helpers" check failed for the same reason (commit `9433b76` added the `waiting` group) and known gaps already listed all three together. Bugs filed one failing test at a time need this check.

A failing case stops at its first failed assertion, so the assertions after it are unverified. For a test-defect bug, read the whole case against the code and state each wrong expectation in the task, or say "fix every assertion until the case passes". Fill "Expected vs actual" from the run's assertion message rather than leaving it "Unknown". B.030's line 132 expected the wrong Video tooltip, and only the RCA found it.

## Bug reports filed from a test failure (duplicate check)

Before finalizing a bug that names a failing test, run `git log --oneline -15 -- <test file>` and grep the bug list for the same case name. A bug filed against an older revision may already be fixed: B.028 (RW-C01 expects the removed disabled-tabs list) duplicated B.030, merged as PR #177, and four steps spent a run rediscovering that. Ask the filer for the revision the failure was seen on, or record the revision of the run that produced it. If a recent commit already changed the test, close the bug as a duplicate instead of planning a fix. A test title in the report that differs from the title in the file is the tell.

Plan for a worktree without `web/node_modules`: the registered `web` suite then fails whole files with `ERR_MODULE_NOT_FOUND`, which is an environment failure, not a code one (see [Baseline verification](#baseline-verification)). The first writable step runs `npm ci --include=dev` in `web/` before judging any result.

## Referencing another task's deliverable

When a task's acceptance criteria lean on another task number's deliverable (a data model, a UI pattern, a shared field), grep the codebase for that task's number and for the feature it's supposed to add before writing the dependency into the spec — don't assume it shipped because it's an earlier number. Task 5.017 twice referenced task 5.003 ("the live step timer") for the step's live elapsed time and the Running card's step name/time; 5.003 had not landed, so Development had to invent a minimal substitute on the spot for part of the acceptance criteria. Either sequence the dependent task after the one it needs, or state explicitly what the task must do when the dependency turns out to be missing (build a minimal version itself vs. defer that piece and say so).

## Pin a UI mockup's implied arithmetic

When an approved UI mockup shows concrete numbers that imply an arithmetic rule the spec text itself never states, write that rule into the task's acceptance criteria or an explicit decision line rather than leaving downstream steps to re-derive it from the image. Task 5.017's UI Planning mockup showed "3 of 7 done · 1 skipped" over a 7-item checklist, implying the total count includes skipped items while the done count excludes them; the spec never pinned this down, so Test Case Planning had to flag it as an assumption and Development had to confirm it before implementing.

## Features that read or run in a task's working copy

A run's work lives in one of three places: its own worktree, the Project's folder (a run started without a separate branch), or nowhere once Complete removes the worktree and keeps the branch. For anything that reads, diffs or runs commands there, state the behaviour for all three. Precedent (5.008, `server/src/projects/quickLook.ts`): a removed working copy answers 410, a run without a repository 409, a path outside the root or into `.git` 400, a diff file outside the changed set 404. For a diff, also say what it compares in each place (5.008: worktree = merge base to files on disk, uncommitted and untracked included; removed = kept branch vs base; project folder = HEAD vs working tree) and how renames show.

## Bug reports that restore earlier behaviour

When a bug says "restore how X used to look or behave", check the description against current `main` and the docs before writing the task:
- **Has it already been partly restored?** Grep for the feature since the bug was filed. Task 5.002 (missing running dot) was filed before 5.008 put back a plain dot on the header and dropdown, so half its problem statement no longer matched `main`.
- **Does the remembered look agree with the docs and existing UI meanings?** 5.002 said "blue", `docs/architecture.md` said "green", and blue was already Quick look's "minimized" tone. Pick one and say how any clashing state stays distinct.
- **Do current UI rules forbid any option offered?** Looping animations (`animate-pulse`/`animate-ping`, infinite keyframes) are banned by `web/tests/gpuFriendlyUi.test.mjs`, so "glow or pulse" means a static glow. Don't offer a banned option.

## Bug reports with an unconfirmed symptom (B.035 precedent)

When the owner reports "not in sync" or similar without the exact symptom, the task lists each suspected symptom and says which ones are this bug and which are separate, before RCA starts. Check every phase of the record's life, not only the steady state: before it exists (a delayed start such as `DOCS_BOOTSTRAP_START_DELAY_MS`), while the start is still being set up, running, needs input, done and failed. An expected result like "visible immediately" covers those early windows too, so either scope them in or write "out of scope: the first N seconds and the set-up window" in the task. B.035 left this open; every step fixed only the confirmed Running-column defect and reported the early windows as a separate gap.

## New fields on stored records

For an optional list or flag field also state: how `null` and wrong types are treated on the API and at workflow save, the exact 400 body and whether the message names the offending value, and what an absent field defaults to for existing user-edited workflows. 29.002 left `null` and the wording to Development and test planning. Flipping a default (skills now on demand) also needs the task to say which shipped steps opt in to the old behaviour.

When a task adds a field to a stored record (a command run's `location`, a step's `quickLook`), say how records written before the change read and display (5.008: a run without `location` shows as "Main checkout"; an absent `quickLook` is None).

If the web reads the new field, list the client mappers it must pass through (for plan items, `toPlanItemData` in `worldStore.ts`, which copies fields one by one) and require a test that feeds the daemon's shape through the store. B.005: report-session tasks gained `reportSessionNumber` and `relatedBug` on the server and in the web types, but the plan never named the mapper, and tests built store items by hand, so the session panel never showed them.

## Reusing an existing control

When a task says a new place offers "the same" commands, log or browser as an existing control, say whether it is a view in the step detail or an action control, and list the existing behaviours it must keep or drop: minimize and reopen, running indicators, Re-run, history. 5.008 went through three UI rounds because the Commands quick look was specified as a third view but the person wanted the header's dropdown, with minimize and no Re-run for task runs.

Read the reused control before describing its failure path. `StartTaskDialog` catches a rejected start itself, shows the reason inside the dialog and stays open; the alert area under a detail header (`ActionAlerts` in `TasksPanel.tsx`, fed by `useTaskActions`' `error`) is a different display. "Shown through the existing error display" does not say which, so name the one meant.

## Evidence requirements

When a task says work must be "validated" by test runs, it must say which runs count: triggered by whom (agent or manual), from which Tasks, after which approval or change, and whether a run with failing tests but a parsed result counts.

## UI scope

Before planning a new workspace tab or Settings section, read the "Workspace layout rules" in [blueprint.md](blueprint.md#workspace-layout-rules): they hold the one-declaration rule, the read-only wrapper rule and the known "content starts half way down the popup" pitfall. UI planning and code review should check a new tab or section against them.

Web test plans must fit the harness: there is no DOM, only static rendering through `web/tests/renderHelper.mjs` (`.docs/testing.md`, "Writing web tests"). Plan layout and render guarantees as pure-function and source checks, and list pixel measurement, focus and scroll checks as manual browser steps with a named owner (the verifying step runs them with the real-browser recipe), not as "render" cases.

For a view with side-by-side panes whose content grows (lists, checklists, renders), state its height behaviour: it fills the remaining height and each pane scrolls inside itself, or the page scrolls. When a task sets a fill-height rule for some tabs of a page, list every tab of that page as in or out with a reason. 36.001 put the Concept page's agent tabs on the full-height layout and left Video out without one, so its columns grew the page until bug B.027 added it (guarded by the 36.001 layout test in `web/tests/contentStudioRender.test.mjs`).

When a task moves or renames a screen, the spec names: the new label for anything whose name would collide with another (e.g. generic "Connections" vs the SEO Building's), whether the old value is persisted anywhere (grep first), and whether a type can opt out of the moved sections. State "no opt-out" or "not persisted" outright when true. "UI conventions" docs are `planning-notes.md` "UI scope" plus `blueprint.md`; there is no separate file.

When a task links to a screen that is still a placeholder (for example the Testing tab before 2.005), say whether the task builds that screen and list its data sources (endpoints, WS events). Otherwise UI planning widens the scope on its own.

The same check applies when a task or its UI mockup names a screen or tab that may not exist as its own top-level entry at all: check the actual current tab/section tree (e.g. `ProjectWorkspaceModal`'s tabs) before assuming one exists. Task 1.002's spec and its approved UI mockup both described a standalone "Commands" workspace tab for a notification deep link; `ProjectWorkspaceModal` only has Commands as a section inside Settings, so Development had to pick an interim answer (route to Settings → Commands) that the task should have specified.

Check what kind of element each existing UI piece is before grouping them in a rule. Centred popups are `DialogContent` dialogs; the Notification Center and Settings are side sheets (`sheet.tsx`); WorkflowRunView's output has a full-screen dialog; dropdowns and tooltips are Radix poppers. Task 5.015 listed the Notification Center among the "centred popups" that get a 50px margin, and UI planning needed a second round to put it back as the drawer it already was.

## Several controls opening one popup, or a new ranking

Precedent: 12.003 (rules in [blueprint](blueprint.md), "Tasks popup"). Planning left these to Development, which had to guess from the mockup. State them in the task:
- **Trigger wiring.** The popup's id in the footer's shared open-popover state and what each trigger's `aria-controls` points at. Name the element that anchors it and handles pointer-leave when several triggers share it.
- **Visible words.** Any state word, prefix or badge wording the mockup adds ("Active", "Needs you", "Pending") goes into the acceptance criteria, as does whether the old detail text stays unchanged beneath it.
- **Name tie-breaks.** "Ignoring case" does not say how accents or locale compare. Name the comparison (`byName` in `web/src/lib/footerPopovers.ts` today) or say accents are out of scope.

## Matching an existing control's wording

When a task says new UI shows the same states as an existing control "consistently", check that control's labels and tooltips (the Planning board card's live state is "Running / Waiting for input / Between turns", `liveTitle` in `TaskRows.tsx`) and say whether the words must match exactly or only the colours and rule. If the task uses different words, say they are intended. In 6.001 the popover's "Waiting for your answer / Idle" differ from the card's; every step flagged it and Development kept the task's words with shared colours (`PLANNING_LIVE_DOT`). The board's status badge words are Running, Needs you, Stopped, Failed and Completed (`CompletedRow['statusBadge']` in `web/src/lib/projectTasks.ts`); a not-started card has no badge, so a "Ready" badge is new wording and needs its variant chosen in the task.

For lists the task orders "alphabetically", say whether case is ignored and how equal names break ties (6.001: case-insensitive `localeCompare`, then project id). For each row field, say what shows when its source is missing (no session number, plan not loaded, record deleted before the click).

## Restyling a shared component in one view

When a task restyles a component in one view only, and other views also render it (`ProjectStatusDot` and `TaskProgressBar` appear in both the 3D labels and the cards view), read the component first and say how the per-view style gets through. Inline `style` values such as a `boxShadow` beat any CSS selector without `!important`, and Tailwind classes merge through `cn`. Choose one approach in the task: a view-scoped CSS override, a CSS variable the component exposes, or a new prop, plus which shared-source tests (`web/tests/projectCardsView.test.mjs`) may change. Precedent: the glass-badge labels moved the dot's glow colour to `--dot-glow` so the label could shrink the glow without changing the cards.

When the person approves a mockup that still lists open questions under "Where to focus" or "Risks and open questions", or whose review comment replaces a task requirement (14.001: "the same refusal as Plan" became a session created without a CLI), copy each question into the task with the answer the approved mockup shows (for example, the progress bar inset `mx-1.5` from the pill), so later steps don't have to reopen it.

## UI that stays above popups

When a task puts a control in front of open popups (precedent: the 5.015 status footer), the task must say:
- what a click on it does to an open modal dialog or sheet. Radix dismisses on any outside click, so the control needs an explicit exclusion (`isStatusFooterTarget`); also say whether a second click toggles its own panel closed;
- which layers must avoid it: centred dialogs, side sheets, the full-screen workflow output, toasts, and dropdowns/tooltips inside popups (poppers share `z-[150]` with dialogs and size to the whole viewport);
- whether it must stay reachable by screen readers and wheel scroll while a modal is open. Radix modals hide everything outside them from assistive tech.
- for a popover or panel it opens (portalled to the end of `<body>`), how the keyboard reaches its items (Tab order skips a portal, so say whether Tab must reach them or arrow keys from the trigger are enough) and where Esc puts focus when it was opened by hover rather than focus. Wheel scrolling inside it under a modal needs native `wheel`/`touchmove` listeners that stop propagation; React's `onWheel` doesn't get past the modal's scroll lock (6.001, `PlanningSessionsPopover.tsx`). Name a real-browser check for scrolling over an open popup.
- **Opposite case: a layer that must stay clickable under a modal** (22.003 toasts). Radix sets `pointer-events: none` on `<body>`, so a layer mounted outside the modal goes dead. Name the exclusion helper to mirror (`isStatusFooterTarget` -> `isToastTarget`), the selector it matches, and whether it is needed on pointer and focus-outside events. Say which other outside-dismiss surfaces must also ignore it (footer popovers, Radix poppers) or are explicitly left closing. Treat a root cause given only as a hypothesis as a first step: the first writable step confirms it in a browser (or states it cannot) before coding.
State the stacking as an order between layers ("the drawer opens above the Workspace"), not as z-index values. Same-z Radix layers stack by mount order, and a raised z-index can hide a layer's own poppers.

For a 3D scene overlay (`<Html>`), the layer order against the app chrome is: scene labels below the HUD cards and top bar. Check a z-range or popup named in a code comment against the code before planning around it (B.026: the "popup at [10000, 1000]" existed only in comments).

## Totals across projects

A requirement that counts or summary values be "correct on load without opening each project" must name the data source. The web app loads each project's tasks and workflow runs only in `loadProjects` (all projects, since 5.015: one request per project for plan, tasks and runs) or on opening a workspace; a server summary endpoint would need its own API contract and server tests. Define each count with the board's own derivation (`buildTaskGroups` in `web/src/lib/workflowTaskGroups.ts`, `buildPlanningRows` in `web/src/lib/projectTasks.ts`), so edge states (stopped, paused, nested ready tasks) follow the columns. Live updates for project removal can't be specified as-is: the WebSocket has no project-deletion event.

## Scope "lasts while the popup stays open" across every remount path

When a task asks for transient, unpersisted UI state that should "last while the user stays on \[a] board in that popup" (not storage-backed, reset on next open), name every way that view can remount within one popup open, not just the one example given (e.g. "going into a card's details and back"). `ProjectWorkspaceModal` mounts `TasksPanel` fresh on each Project Workspace open *and* on every switch away from the Tasks tab and back (`{topTab === 'tasks' && <TasksPanel .../>}`), so plain component-local state (the simplest, correct implementation) resets on a tab switch exactly as it does on popup reopen. Task 5.018's spec named only the card-details round trip and the popup-reopen reset; Test Case Planning had to flag the tab-switch case as an assumption and Development had to confirm it matched intent before relying on it. State explicitly which remount paths must preserve the value and which may reset it, so later steps don't have to infer "stays within the popup" from reading the shell component's conditional-render structure themselves.

A responsive rule that removes an element ("not rendered at all below 1200px") is one more remount path. If its state must survive a resize, say so and say that the state belongs to the surrounding view (as `useSessionTaskPanelState` does for the planning session's task panel). Give a width rule as a comparison on the viewport width, including fractional widths: "wider than 1200px" shows at 1200.5px, while a `min-width: 1201px` media query does not.

For a popup-lifetime choice, name its home and the reset events. In this project `WorkspaceContent` in `web/src/ui/ProjectWorkspaceModal.tsx` is keyed by project id and unmounts when the dialog closes, so `useState` there resets on close, on a project switch and on reload, and survives Back, opening a task, tab switches and a resize past a breakpoint; state in `TasksPanel`, `TaskDetailsView` or `useSessionTaskPanelState` does not (12.002). Also say whether a same-project `openWorkspace` (a notification deep link while the popup is open) resets it; 12.002 left this open and Development chose no reset, because the state is not in the store. Plan its cases as pure helpers plus source pins: the web has no render harness ([testing.md](testing.md)), so do not list "integration" cases that need a rendered tree, and say which behaviours only a browser can show (focus retention, refit of the live terminal).

## Verify current code before specifying a removal step or a closed set

A task that names specific files/symbols for deletion, or that replaces an existing open-ended field with an exhaustive enum, must be checked against the current branch — not an older milestone doc's history — before it's written:
- **Removal steps.** Grep for the named file or symbol first. Task 1.002 named `server/src/notifications/notificationAgent.ts` and its wiring for deletion, plus the literal strings `settleBlocked` and `"Could not resume after restart"`; a prior milestone had already removed/renamed all of them (per `docs/architecture.md`'s existing "Added, 2026-09-25" amendment), so the step was a pure no-op that still cost an implementation pass confirming there was nothing to do.
- **Removing a behaviour (B.020, stacking).** List every doc line that describes it, not only the ones the task names: grep `docs/` and `.docs/` for the term and its synonyms ("stacked", "stack-merge"). B.020's Development pass missed the Complete-stage description in `docs/architecture.md`, which still said the PR base could be the stacked branch.
- **Closed enums/kind lists replacing an existing open-ended field** (e.g. a free-text `originFeature` → a fixed `NotificationKind` union). Grep every current caller of the field being replaced, not just the producers the motivating request mentions. Task 1.002's closed 6-kind table omitted two already-shipped producers (`testRunner.ts`'s manual test-run notification, `workerManager.ts`'s workflow-attention notification), forcing Development to invent two extra kinds and a coarser subject for them unilaterally, mid-task, instead of planning scoping them in up front.

## Rules that classify provider data (19.002 required checks)

Precedent: 19.002. The spec fixed the rule but left presentation and edge choices to test planning and Development, who each guessed. When a task changes how provider data is classified or shown, state in the task:
- **Wording for every sibling case**, not only the one named (optional failing was given, optional pending was not), and where a warning lives (a separate field beside the blockers, an empty list rather than absent).
- **The list-length rule** for named items (how many names, then "+N more", and whether a tooltip is required) and what a partial or truncated provider answer means (here: unknown, so every non-passing check blocks).
- **Unrecognised values:** an invalid reading or unknown? State which.
- **Sound and notification edge rules**: does a change between two attention states replay, does an attention state with the switch off play, does a task with no record that becomes Merged chime, which notification kinds a state change resolves.
- **Limits already enforced elsewhere** (a PR number's range is checked by the route): cite the existing check instead of listing a case for it.
- Check the baseline counts against [testing known gaps](testing.md#known-gaps) when writing the task; 19.002 quoted a stale "1 server failure" while the registered run shows load-dependent extras.

## Per-task switches that act on their own (10.017 Auto-merge)

Precedent: 10.017. Its spec fixed behaviour but left these to Development, which then chose them alone:
- **Which record holds the switch.** "Task" in a spec is the plan item (the board card), which follows its latest WorkflowRun; a `TaskRecord` is one session. Name the record, and say which run's data (PR link, branch, agent) the switch follows when a task has several runs.
- **Route, body and stored shape.** Method, path, body, response, what turning off does on an ineligible task (always allowed), what a record without the field reads as (off), and a separate Retry route with the states it accepts.
- **Every stored state, and who may leave it.** For each state say whether the automatic poll retries it or only the person (toggle or Retry) does. Name the read-only watch a person-owned state still gets (a PR merged by hand moves Failed to Merged) and that a failed read in such a state changes nothing.
- **Shared turns.** If automatic work is serialised per project, say whether a long-running step (a conflict run) holds the turn and for how long at most; an unbounded wait stalls every later task.
- **Notification set.** List each state that raises one, kind and subject, including states the spec only names as errors ("no PR", "cannot be merged").
- **Mockup picker counts.** A picker that says N states must list N; count them before approving.
- **Board placement after the server says done.** A switch that keeps work going after the run completes (a PR still to merge) must say which board column the task sits in during that time, for every stored state, and how counts, progress and the attention dot treat it. Column placement reads run/item status only, so 10.017 shipped with such tasks in Completed (fixed in 10.017.001). Also say whether the same rule applies to tasks without the switch.

## Changing a start gate or queue (31.003 Waiting list)

Precedent: 31.003. The task described queue routes and web client hooks that did not exist, and left the gate undecided, so Test Case Planning, Development and Review each flagged it:
- **Grep every surface the task calls "existing" before release.** Routes, client functions and store state (`GET /projects/:id/plan-item-queue`, `DELETE /plan-item-queue/:entryId` were absent). If missing, list them as work in the task.
- **Say how an old gate relates to the new one** (`executorHolder` against the slot cap): replace, fold or keep, and what that changes for existing starts such as testing setup running in parallel. Name who confirms a behaviour change.
- **Say whether neighbouring blocked starts queue too**, e.g. a no-repository Project whose folder is held by an unsettled run, and whether they raise the `task.limit_reached` notice.

## Tasks that wait on other tasks (10.018 Dependent tasks)

Precedent: 10.018. The spec fixed the behaviour but left these to Development and the later steps, which each guessed alone:
- **Limits as numbers.** Any "sensible limit" or "capped" needs a value and the error text. Chosen: 20 parents per task, chains of at most 10 tasks (`MAX_PARENTS`, `MAX_DEPENDENCY_DEPTH`).
- **Every route's odd cases.** For each new route, say what a call in the wrong state returns (cancel on a task that isn't waiting: 409) and whether a cleared list is `[]` or absent (`[]` on writes, absent on stored tasks).
- **UI surfaces named in a spec must exist.** "From the board card's menu" named a menu that cards do not have. Check the target control in `web/src/ui/project-popup/TaskBoard.tsx` and either name the replacement (a small action on the card) or drop the line.
- **What the card shows in each stored state**, not only the new one: a ready task with parents but not waiting needs a stated display (a "Depends on #12" chip).
- **Board column for every stored state, and the hierarchy visual.** 10.018 left a started-but-waiting task in Planning because column placement reads only plan-item status and the run, and a waiting task has `pending` and no run (fixed in 10.018.003: `buildTaskGroups` sends run-less `waiting` rows to Running; 10.018.004.001 then split them into a `waiting` group because the footer read the Running group as "Active"). A task that adds a state between "ready" and "has a run" must name its column, badge and counts (a board column is not a footer state: say which of active, blocked or pending each footer count and popover row uses, and require a test that the footer total equals the popover rows) (footer, popovers, Chain filter, drop guards) and say how a relationship between cards is drawn (nesting, connector, or text) including parents in another column or group.
- **Widening a picker or rule: name the field mapping and the server outcome per new state.** Task "started tasks as parents" said children "stay Waiting" but the server marks a parent that needs input as Blocked, and never mapped "in progress / needs attention / completed not merged" to stored fields. State each new state as stored fields (`status`, `autoMerge.state`, `pullRequest.state`), its label, and the child's verdict from `evaluateParent`; use the server's real reason text, not paraphrase.
- **Every entry point of a changed action.** 10.018 made Start branch on `row.dependsOn`, which only the board's rows carried; the planning panel's Start passes `{ id, title }`, so a dependent task hit `/execute` and got 409 (bug 10.018.005). When a task adds a branch to an existing action, grep its callers (here `actions.start`, `kind: 'start'`, `PlanningTaskPanel.tsx`), list each in the spec, and decide from stored state (`startPlanItem` reads `planByProject`), not from fields a caller may leave out.
- **Notification subject type** for new kinds, named like the existing ones (reused the task-scoped `autoMerge` subject).
- **Manual acceptance evidence.** A "real run against a throwaway repository" or browser check cannot be done by an unattended run; list it as a person's follow-up, not as an acceptance criterion the run must meet.

## Running part of a workflow ahead of its gate (38.002 Early UI Planning)

Precedent: 38.002 ran a waiting task's UI Planning before its parents merged. The brief fixed the main path but every later step had to settle these alone:
- **Name the step by shape, not by its label.** "The UI Planning step" became: `steps[0]`, id `ui-planning`, `requiresApproval` true, `canEditCode` false (`earlyStepOf`). Say what a renamed, reordered or custom workflow, a bug's Bug Fix workflow, a start with the step unchecked and an in-place start (`createBranch: false`) do.
- **An exit table: every action against every new state.** List the new states (queued for a slot, running, at approval, revising, approved and waiting, released but waiting for a slot) and, for each, what Cancel waiting, Remove from waiting list, archive, delete, restart, parent cleared and parent failed do. 38.002 wrote the discard rule for "a waiting task" only, so archiving a released run still in the slot line kept it (caught in Code Review).
- **When a per-task setting can still change.** For a setting that steers a started task, say in which states it is editable, what toggling it does in each (start, dequeue, refuse 409), and whether a now-destructive action (Cancel waiting that discards work) asks for a confirm.
- **Slot use of every continuation.** Today approve, Request changes and resume continue without claiming a slot. Say for each whether the new kind of run claims one, and how a paused run gets back in line (38.002 added a `resumeRunId` queue entry, started outside the queue lock).
- **Stored versus derived state.** A "phase" named in the task is a display value unless the task says it must be stored; prefer deriving it from the run and the queue entry ([Derived values the data may not hold](#derived-values-the-data-may-not-hold)).
- **Which session tools exist.** "The planning session sets dependencies" was wrong: only Plan & bugs has `set_dependencies`; a plain planning session has `update_task` only. Grep `server/bin/*-mcp.mjs` before naming a tool, and say whether a combined write (parents plus setting) is one atomic call.

## Tasks that depend on an unmerged task

When a task reuses another task's deliverable ("reuse 6.001's popover, stop and flag if missing"), planning checks the target branch for it before the task is released and names the fallback in the task: wait, or build the shared piece here and say who reconciles it later. Task 6.002 said "stop" but ran autonomously with 6.001 absent, so Development built a stand-in shell and acceptance criterion 1 ("identical to 6.001") could not be checked. The stop instruction can't work in a run that has nobody to answer it. When a bug waits on another task, recheck its suspected locations against the target branch after that task merges and drop or mark the items it already fixed: 31.002 had fixed three of the five sites bugfix 21.001.005 still listed as live.

## Derived values the data may not hold

For a "time in current state", "since when" or similar value, name the field it comes from, or say it is approximate, in the task. Also state where rows without it sort, the label for a missing optional value (e.g. "No agent assigned" or omit) and the match rule for "show the number once". Task 6.002 left all four open; the choices are recorded in `.docs/blueprint.md` (status footer).

## Routing errors between a form and notifications

When a task splits failures into "shown in the form" and "becomes a notification" (precedent: 6.003, `ACTION_SCOPE` in `worldStore.ts`), the task must say:
- **Which actions are in-context**, listed by store action name. A form means the control already shows its own result in place; an action with no such display (delete command, set project workflow, Commands panel run) notifies.
- **Scope granularity**: one scope per form, or shared by related forms. Shared scopes show each other's failures (the three Catalog editors share one), which is looser than "only its own action's error".
- **Shared actions called from several places** (`runCommand` serves Quick look, the Commands panel and the notification "Run again" action): say which caller owns the in-place display, or the store can't tell where the failure belongs.
- **Which project a notified failure is attributed to**, per action, so it isn't shown as "System" when the project is known.
- **Ambiguous daemon answers**: when one status code covers two cases (transcript 404 for an unknown task and for no transcript yet), say how to tell them apart and where (daemon or client).

## Changes to a planning session's detail view

`TaskDetailsView` serves a planning session from two places: the Tasks board and the Archived tab. Say which of them a change applies to. The task panel (9.001) is Tasks-board only; the Archived tab keeps the history strip at every width.

When the view opens another detail (a task's run or session), say where that detail's Back leads, and what it does when the origin session was archived or deleted meanwhile. Current rule: back to the origin session while its Task exists, else the board (`detailBackTarget` in `web/src/lib/planningTaskPanel.ts`).

A rule such as "completed rows open the finished-task view" must cover the task that is done, archived, and has no run or session: it sits on no board column, so the board's card lookup (`findCard`) does not find it.

For a list of a session's tasks, also state the tie-break for equal creation numbers, what an empty list shows when tasks existed but were all removed or archived, and what happens to a row's inline state when the task changes category elsewhere.

When an approved mockup does something the task text does not ask for (9.001: moving focus to the row after an accepted start), add it to the acceptance criteria or mark it as not required. Otherwise Development decides alone whether the mockup or the text binds.

## Footer counts that explain a blocker (B.025 precedent)

When a footer count or list must account for something that blocks or holds an action (an app update, a start gate), the task states:
- **The rule as parity with the blocker.** Name the blocker's counting function (`computeBlockingCounts`) and say each footer number equals one of its terms. Add a test that builds one fixture covering every blocker source and compares the footer totals with the blocker's, on both sides if the total is built in the web. B.025's RCA left this to the Fix step, which tested the server side only.
- **What happens to rows the old count included but the blocker does not.** B.025 left open whether an open planning session with no live PTY (pseudo-terminal) still counts; the answer was no, because it cannot block. Decide it in the task.
- **Session kinds only if they can be told apart.** Ad-hoc inspect CLIs run on a task id like task CLIs, so they cannot be a separate kind without exposing worker internals. Check how a kind is identified in the registry before naming it in the task.
- **The live-update mechanism**, by event name (here the `terminalSessions` websocket snapshot), and that queued and loading paths in the store cover every status the blocker counts.

## Features that restart or replace the running app

State up front which running work the feature may interrupt, and give each blocking or "busy" count a one-line definition against a named store or registry. Say whether a count means live or ever-created: 7.001's terminal-session count first read a never-pruned map and would have held every server update forever. Require at least one test per count against the real registry, not only a fake that returns zero. A state that is shown after an action (updated, failed) must say when it ends and what the next normal state is. Name which existing controls the feature adds actions to (here the footer's "Check now"), and decide hidden versus always-visible for a neutral state in the task. Where the spec says "Development picks one" (for example cancel with nothing pending: 200 no-op), the task should record the choice in the blueprint. Real-process and real-remote checks cannot run in the coding stage, so list them as a manual acceptance step with its own owner.

## Splitting a synchronous action into accept plus background work

Precedent: 11.001 (instant task start; current rules in [blueprint](blueprint.md), "Starting a task"). When a task moves slow work out of a request, settle these in the task, not in Test Case Planning or Development:
- **Response shape.** What the endpoint now returns when the old result (a Task, say) does not exist yet at accept. Name the record, status code and which web client call changes.
- **Creation timing.** Which records exist at accept and which only at the end of the background work (first-step Task, branch, worktree), and what the slot, queue and "unsettled" lists count in between.
- **Side effects at accept.** Where one-off follow-ups run (planning-session auto-complete) and whether an accepted-then-failed action keeps them.
- **Persisted progress shape.** Field name, step fields, and absent versus empty for records from before the change.
- **Stop and restart while in flight.** Does Stop wait for the step in flight or mark Stopped at once; what cleanup is owed; whether Retry and Resume reuse the run or create a new one; what restart recovery does with partial setup; and any wait bound's value.
- **Failure status.** Which plan item status a failed background step maps to.
- **Serialisation.** Which shared resource (repository, branch names) setups must still take turns on.
- **Stop coverage.** If "at each step" is a criterion, list the steps and require a test gate per step, or say which are untestable.
- **Other readers of "running".** Search for every place that filters on the live status (`running`) (app-update blocking, folder guard, counts, queue) and list which must also count the new status.
- **Moving a long action onto another trigger (37.002: the render moved from an agent tool to Finalize).** Name in the task whether the request waits for the action or answers at once with the outcome arriving through the published view (a multi-minute request is fragile; say which), every 409 precondition (unconfirmed, setup not ready, action already queued or running, already finalized), whether the action is still allowed after the agent session ended or with no session record, the read-only status, and whether the old route is removed (404) or kept. Test Case Planning and Development each had to guess these.

## Cross-process features: pin the mechanism, names and measurements
When a requirement spans the browser and the daemon (e.g. "do not notify if the person is looking at it"), name the mechanism in the task (which side knows the state, which message carries it, release on close/minimize/disconnect, re-send on reconnect) and its message size limit. New notification kinds need their kind ids, severity, subject type (and a new subject type when none carries the run id) in the task. 12.001 left all of these to Development: `watchRun`/`unwatchRun` on `/ws`, `command.completed`, `testing.passed`, subject `testRun`, 128-character id cap.

## Mockup pixel values and data a label needs
State what a mockup's pixel value covers (content box or including borders) for the single height constant (the footer's 46px). When a spec says a row shows a field (the task's "number"), check that every record kind that row can come from carries it; test runs carry only `taskId` and `branch`, so "task number" needed either a lookup requirement or a branch fallback. Pluralisation of count wording ("1 running commands") must be decided in the task, not copied literally from a template.

## Calls, events and links between Buildings
Precedent: 10.005 (current rules in [connections](../docs/connections.md)). Test Case Planning and Development each guessed the same open points; a task that adds or extends such a mechanism states them up front:
- **One status per refusal**, in check order: unknown Building or capability, no link, not granted, broken link, depth exceeded, bad input, busy or not ready, read timeout, call from an inactive run, a run naming another Building as caller, cross-tenant, held for approval, repeated idempotency key with other inputs, duplicate link, self link, handler output not matching its declaration, event dropped by a rate limit. Copy the table from `docs/connections.md` and say what changes.
- **Which callers a waiver covers.** "A link may mark it pre-approved" needs the caller kinds it applies to (scheduled jobs only today) and how a workflow-step session is labelled as a caller.
- **Numbers.** Idempotency window, key length, events per hour, activity page size and maximum, timeout, depth limit, summary length, and whether any input type is a date. Defaults are in `connections/rules.ts` (`DEFAULTS`).
- **Input rules.** Unknown fields, null versus omitted, case-sensitive enums, and whether a cap counts characters or bytes.
- **Approval model.** Per call or a WorkflowRun step on the Tasks board. 10.005 built per call, answered in the Activity log.
- **UI paths that must exist.** Before asking the web to react to an action (a Building being deleted), check that the web has the action. The web has no Building-delete screen, so 10.005's review asked for web cleanup that had nothing to hook into.
- **Restart behaviour of each in-memory store.** Say which state must survive a daemon restart (the event outbox does; idempotency keys do not).

### Task-report capabilities and default-on grants (10.021)
Test Case Planning and Development both guessed these; a task that adds a read capability over tasks or changes link defaults states them:
- **Status and phase for every lifecycle value.** Give a table from lifecycle (including archived-after-done, archived-never-done, failed, stopped) to status id and phase; the spec's phase list is shorter than its status list.
- **Truncation.** Cut length per text field, the shape of the `truncated` flag (per field plus top level), and the step cap.
- **Input limits.** Maximum length of id, number, search and cursor; whether `since` accepts date-only values (use the Activity log's `parseWhen` unless stated); whether a cursor from other filters is a 400.
- **No-run tasks.** Say whether steps come from the workflow it would use or are empty.
- **Default-on grants.** Say separately what the API does when `capabilities` is omitted (grants none) and what the screen pre-checks; for an upgrade, name the marker (`grantsVersion`) and what a missing target project or type does.
- **Two paths to "completed".** If a detail view and a list both derive completion, say they use the same run lookup.

## Features that parse another tool's output (CLI, API)

Precedent: 10.013 (per-project GitHub account). The task said "accounts come from `gh`" but not which command, which output format, or the minimum version, so test planning wrote parser cases (U1–U5) as guesses and Development wrote fixtures from memory. State in the task:
- **The exact command and output mode** to read (prefer a machine-readable one such as `--json`), the minimum tool version, and what an older or missing tool does.
- **Where fixtures come from.** A person or the first writable step captures real output (with the tool installed) and the fixtures are copied from it; otherwise list the parser under "unverified until a manual check" in [testing.md](testing.md#known-gaps) and the acceptance criteria.
- **The edge decisions the spec leaves implicit**, so test planning does not need assumptions: what happens to stored state when its precondition later disappears (here: the repository stops being on github.com), what a field absent versus null means, and which values have a length limit.
- **Flags of a third-party CLI exist.** Before a task writes a flag or behaviour into the spec ("bound to 127.0.0.1", "--host"), check it against the pinned version's real CLI (`npx <tool>@<version> --help`, or `npm pack` and grep its source). 32.008 assumed a host flag for Remotion 4.0.529 Studio; it has none and binds every interface, so Development had to add a `NODE_OPTIONS` preload. If it cannot be checked, write "unverified: the first writable step checks it and names the fallback".
- **Baseline wording.** 10.013 again wrote "known failing tests are the expected baseline"; use the wording in [Baseline verification](#baseline-verification). The writable first step runs the fresh baseline, since test planning cannot.

## Background automation on the checked-out branch

Precedent: 10.014 (auto-pull, [blueprint](blueprint.md) "Auto-pull"). The task left these to Development and Code Review; state them in the task:
- **Setting contract.** Field name and default for old records, the route (this project uses a per-setting route such as `PATCH /api/projects/:id/auto-pull`, like `/workflow` and `/git-provider`, not `PATCH /api/projects/:id`), the 400 for a non-boolean and the refusal for a Project without a repository.
- **How a decision reaches the person.** The exact reason strings, their priority when several blockers apply, and the carrier field (`ProjectSyncState.deferredReason`, `lastAutoPull`). Check each reason can actually be produced: the poller reports a detached HEAD as `unknown`, so "detached" never reaches the tooltip unless the task asks for it.
- **History marker.** How an automatic run differs from a manual one (`automatic: true` on the command run, an "Automatic" badge).
- **Failure back-off.** The key (remote SHA plus reason), what clears it, and the notification kind with severity and subject type.
- **Notification identity.** `raiseNotification` dedupes and resolves on kind plus subject. Before a task reuses an existing kind (e.g. `storage.problem` with a project subject, which `seo/sync.ts` also uses), check who else raises or resolves that pair; a shared pair merges the two failures and one's success resolves the other. Default to a new kind with its severity, and say the kind lists to update (`server/src/domain/types.ts`, `web/src/lib/serverApi.ts`). 10.010.004's RCA proposed reusing `storage.problem` for a crawl failure; review caught the clash.
- **Counts and stale display.** Where the pulled-commit count comes from (the fetch can bring in more than the last reading showed) and when "Pulled N commits automatically" stops being shown.
- **Re-evaluation triggers.** Which events re-evaluate and whether a chatty in-place task may cause repeated git work (limit it to events that can free the folder).
- **Test cases the plan promises.** Name the ones that need infrastructure (timeout, killed daemon, force-pushed remote) and say whether they are required or listed as manual checks.

## Cross-project summaries built on a per-project reading (10.015)

When a summary (footer count, board, list) aggregates a shared per-project reading, the task states the rules the reading itself cannot answer:
- **Failure with older data kept.** Say whether a failed check that still holds an older list counts as unavailable (footer, no rows) or keeps showing the old rows (PR tab). 10.015 chose unavailable; an in-flight retry stays unavailable.
- **Never-succeeded projects.** Say how they appear in "oldest last checked" (10.015: ignored; "Not checked yet" when none) and in the count ("N checking", no unavailable marker).
- **Poll numbers.** Give the stagger (10.015: 250 ms on load and Refresh all), the in-flight bound (4) and whether becoming visible forces a refresh (yes, staggered), the stale threshold (over 5 minutes) and any row cap (50), plus the target of a "+N more" row.
- **Keyboard behaviour of a shared shell.** If the task needs focus moved into a popover list, say it changes `FooterCountPopover` for every footer popover.

Name the starting branch's health too: after a merge of parallel tasks `main` can fail to compile (10.015 found `worldStore.ts` broken by the 10.013/10.014 merge). Make "the baseline compiles, else restore the merge damage and report it" part of the first writable step.

## Easing or changing a blocking rule (10.016)

Precedent: 10.016 (overlap rule, [blueprint](blueprint.md) "Auto-pull" and "App update"). Task text, UI rounds and test planning disagreed on three points; state them in the task:
- **Removed options leave the task text in the same round.** When a UI round drops an action (10.016: "Discard these changes" was declined), rewrite the Goal, Behaviour, Edge cases and acceptance criteria that mention it before test planning starts. The word "discard" stayed in the task through Development and Code Review, and every later step had to note it. This extends [Reconcile approved UI with the task text](#building-types-and-storage-contracts).
- **Say what each surface shows, not only what it blocks.** "The same list appears where the deferral reason is shown" did not say whether the sync indicator needs a structured list (kind chips, project-name title, a Check again button) or only file names in the existing reason text. Development built the text only and Code Review sent it back. Name the data (`blockingFiles` and `blockingFilesTotal`, capped list plus exact total) and the control for each surface.
- **Fallbacks and precedence.** State which paths the conservative fallback counts (tracked only, or untracked too) and whether an ahead/diverged state beats the overlap list, per flow. Both were test-planning assumptions.
- **Rollback and cleanup commands.** For a flow that undoes its own work, name the git command and what it must keep (`reset --keep`, never `--hard`) and require a regression test or source guard. A script outside the TypeScript tree (`server/bin/`) is untestable as written: require the steps to live in a module and say the script gets a manual run against a local bare remote, owned by Development.

## Keyboard and drag interactions

A task that adds keyboard or drag interaction to existing clickable items states, for every key, which one wins when it is already bound (10.019: Enter both "picks up" and "opens"; Development had to choose Space = pick up). It also says where keyboard focus lands after the item moves, is refused or is cancelled (the item remounts in a new place, so focus is lost unless restored).

**File-drop targets (37.001 Media column).** A task that adds or widens a drop target states, because the web tests have no DOM and Development otherwise decides each one:
- **Testability seam.** Require the handlers as pure functions in a `lib` module (event-like input, callbacks out), spread onto the element, so unit tests can drive them; inline JSX handlers cannot be tested.
- **Per-state answers.** Say what a drag with 0 items shows, whether read-only ever highlights, whether a refused drop (read-only, non-file) clears the highlight, and whether an empty `FileList` drop still calls `preventDefault`. 37.001 settled on: "Drop to add 0 files", no read-only highlight, refused drops do not clear it, empty drop calls `preventDefault` and clears.
- **Browser-only behaviour is a manual check.** Flicker on `dragleave` (`relatedTarget`, null in Safari) cannot be tested; list it as an owner check.

## Spatial mappings and contracts that do not exist yet

When a task says a 2D layout "matches" the 3D scene, name the mapping rule: the default camera views the town diagonally, so "top-left" is not axis-aligned (10.019 chose a top-down map, +x right, +z down, pinned by a camera-projection test). When a task says the server "enforces" a rule, grep first: if it does not (10.019: `PATCH /projects/:id` accepted any position), say the rule is new, the status codes, and whether 400 or 404 wins for a bad value on an unknown id. A shared test stub (`web/tests/serverStub.mjs`) must mirror any new status. New pure modules go in `web/src/lib`, not `scene/`, when a view must not import the 3D engine.

## Redesigning the 3D village (13.001 precedent)

A task that changes how the village draws Projects or their work settles these before UI Planning starts; 13.001 left each one open and paid for it in rejected mockup rounds or mid-development choices:
- **Look.** When the brief names no reference image or style, the style comes from the implemented scene and from any reference the person gave in an earlier round. 13.001's round-3 mockup never saw the round-1 reference image (`IMG_8731.png`) and was rejected; round 4 matched it and was approved. The approved style then replaced the glTF robot.
- **World scale.** Give the footprint per Project in world units, the spacing between Projects, how saved positions are re-spaced, and whether the camera or zoom changes to compensate. 13.001 grew each lot about 3× (`TOWN_SCALE` in `web/src/lib/villageLayout.ts`), which moved the ground bound, ponds and backdrop, but the brief never asked for a reframe; the fixed camera of that time was left behind and buildings fell off screen (bugfix 13.001.001). A scale change lists the camera position, target, fog range, shadow bounds and the camera limits sized for the map (`MAX_DISTANCE`, Home distance in `web/src/scene/cameraMath.ts`; the pan clamp follows `MAP_HALF = ROAD_REACH` from `web/src/scene/townLayout.ts`; `TOWN_HALF` is banned by `villageTerrain` U42) as in scope, and when two open tasks touch the map size and the camera, says which one retunes those constants, with the acceptance check "every occupied yard corner projects on screen at 16:9 and 4:3" (`web/tests/villageScene.test.mjs`) and the same check at full zoom-out (`MAX_DISTANCE`, U33 in `web/tests/cameraMath.test.mjs`). The 12-street town left `MAX_DISTANCE` at 90 and U33 failed until bugfix B.018 raised it to 160 (the fog already sat beyond it).
- **Camera angle.** When a task names a camera "elevation" or "angle", say which one: the centre-ray pitch or the steepest ground ray across the town. With a wide lens they differ by about 15-20° (bugfix 13.001.004: centre pitch 55° read as 70-80° at the near screen edge). Quote the current numbers from `DEFAULT_VIEW` (`web/src/scene/defaultView.ts`, the one source for position, target and fov), not from an older brief, and require a projection test on the ground-ray angle plus the existing frame-fit check. Any change to the view also re-checks `FOG_NEAR` against the farthest yard corner. A task that changes the angle also states the distance rule (keep the current distance unless the frame-fit or fog check fails; the 57° to 45° change kept 68 units, which projected at most 0.717 against the 0.9 margin) and the tolerance for "about N°" (±0.5° in the tests). Also say whether `STREET_ELEVATION` (28°) and the 20°/80° tilt limits stay: Home must keep a clear gap above street and inside the limits (pinned by U01b in `web/tests/cameraMath.test.mjs`).
- **Tag placement rules come with the footprints.** A task that moves tags beside or around items (33.002) lists each tag's world width and the neighbouring footprints (robot, crate, next bay's lane, "+N more" stack, machines) and runs the pairwise overlap arithmetic on the real slot coordinates before approving any per-slot side exception. 33.002 approved a left-side exception and right-side machine tags; both overlapped neighbours (the bays are 3.8 apart and a 1.4-wide tag fills most of the gap) and were dropped in Development. Name the helper shape only if the geometry needs per-slot values; one shared anchor was enough. Tags are sized by `distanceFactor`, so their world size is zoom-independent and no closer-zoom scale factor applies. State the out-of-range behaviour only for helpers that take an index.
- **Home elevation range.** When the task gives a Home elevation range, check the spacing tests against its low end (36° minus `STREET_ELEVATION` 28° is 8°, below the old 10° gap in U01) and say which gap assertion loosens.
- **Keyboard input on the 3D view.** A key-control task states: the sign of each key (which of A/D raises azimuth, whether W raises elevation), the rate in degrees per second and the frame-gap cap, what a key does during a Home or minimap flight, how the terminal pane is recognised (`[data-task-terminal]` or `.xterm`), how the controller learns the covered state (a setter fed from `Scene`), and `event.key` vs `event.code`. The W/A/S/D task (33.003) left all of these open and Test Case Planning, Development and Code Review each flagged them; they now live in `web/src/scene/cameraKeys.ts` and [blueprint](../docs/blueprint.md), so a later key task quotes them. The bugfix 33.003.001 (keys moved only the minimap) was a binding error, not controller logic: the controller was attached to a `MapControls` instance drei later discarded. A task that wires a controller to a drei or R3F object names which instance it binds to (the live one from `useThree`, not a ref) and requires a mount-level check or a browser check, because fake-controls and real-object unit tests pass with the wrong instance.
- **Camera controls.** Interaction described by feel ("zoom like walking down a street") needs its rule in the task: what zoom changes (distance only, or height and elevation too), the distance and elevation limits, what Home and the minimap reset (target, zoom, rotation), click vs drag on a map control, flight durations, and how off-map items are drawn. The camera-controls task left all of these to the UI mockup (street walk lowers elevation to 28° at 8 units; 8-160 units (was 8-90 before the 12-street town); 20-80° tilt; 700/450ms flights; 3px click threshold); they now live in `cameraMath.ts`/`minimapMath.ts`, so a later camera task quotes those constants and says which ones change.
- **Assets.** Check that an existing model has the animation clips for every pose the spec needs before writing "keep the existing robot". `RobotExpressive.glb` had no holding or sitting clips.
- **Scene clicks that open a filtered view.** When a 3D element "opens X filtered to Y", define Y as an existing helper's set and say whether the filter exists. If it does not, say it is new, where its state lives and what clears it. The yards task left "pending (not started, planning)" undefined and Tasks had no filter; UI Planning chose the Planning-column task cards (`pendingTaskRows`) and a transient "Pending only" filter. The badge and the filter must read the same helper so their counts match.
- **Every visual state.** For each item state, say what is present (13.001: is there a robot at a Stopped/Failed box?), which tags are always visible and which only on hover, and which way the item faces.
- **"Keeps" claims.** Before writing that a 3D element "keeps" something, check that the 3D view shows it today. The tower label had no read-only badge; only the cards view did.
- **Reused derivations.** When the scene reuses the Tasks board's derivation but defines its own categories, list which board groupings it splits. The board puts failed/stopped runs and Auto-merge failed / can't merge under Needs you; the yard does not.
- **Performance.** Turn "must not regress" into named test cases on the hot update paths. Each streamed command-log chunk replaces `commandRunsById` (`web/src/store/worldStore.ts`), so any per-Project view selecting the whole run map re-derives on every chunk; 13.001's review caught this, and `useYardModel.ts` now selects narrowed fields.
- **Text matched across server and web.** If the web classifies server text (the yard's merge hints match the daemon's `MERGE_BLOCKERS` English wording), plan a shared constant or a contract test, or record that a wording change drops the match silently.
- **Changing the plot layout or capacity (street-lined map precedent).** State, in the task: how saved positions move (a one-time remap to named target plots, in which order; whether a version marker is needed or the old and new coordinate sets are disjoint), what the server does with a stale client sending an old coordinate (remap or 400), the fallback position when every plot is taken and a project arrives without one, and the wording and threshold of any "nearly full" notice (here 216 of 240, "Map full" at 240; "N projects · 12 streets" counts all streets). `web/src/lib/townLayout.ts` and `server/src/projects/townPlots.ts` are duplicates pinned by a drift test.
- **A map larger than the camera frame.** Replace the "every yard on screen" camera test with the subset that must be visible (the plots nearest City Center) and say which task owns wider coverage, the sun shadow box and fog range.
- **Robot or prop look changes (33.001 precedent).** A "suggested approach" in the brief (bench and laptop) is a candidate for the UI round, not a requirement; the person overruled it (wrench at the box, `Idle` clip). Say in the task that the approved mockup wins over the suggestion, and that a 3D-scene-only task still gets a mockup, which goes through the outputs payload (the UI step may be read-only). State at once the details a model-driven look needs: whether a prop shows while the robot walks or carries (33.001: standing only), exact amplitude and period constants, and that the robot model's bones carry non-unit scale (`Hand.R` is 100), so a parented prop is sized against it.
- **Draw-call budget and ambient animation.** Give a draw-call or mesh budget at full occupancy (a warehouse is about 19 non-instanced meshes, so 240 are roughly 4,000 draw calls, unmeasured) and the manual frame-rate check that owns it. Say whether mockup animation (sway, smoke, ripples) is in scope: the scene renders on demand (`frameloop="demand"`), so continuous animation conflicts with the "no frames when idle" test and needs an explicit decision to change it.

## Read-only integrations with writes nearby (10.007 SEO Pages and Sitemaps)

Precedent: 10.007 (rules in [seo-building](../docs/seo-building.md)). Each point below was settled by the person or chosen by Development after the mockup was approved:
- **Reconcile the approved mockup with later decisions in the same round.** A button the person removes in test planning ("Submit sitemap to GSC", read-only scope) or a number they confirm (quota reserve 200) must be written into the task text and the mockup before Development, or the approved mockup contradicts the task.
- **Never-leak secrets are a task line.** Say which values may never appear in any response, log row or UI (here the IndexNow key; only a shortened file name shows).
- **Pin the contracts the spec calls "open":** endpoint paths and response shapes (null, not omitted), the definition of "new or changed", rate-limit and log-retention numbers, what "clamp to the earliest stored date" means (partial-coverage flag, not a changed date), the default range end (last final GSC day, Pacific time) and the URL normalisation rules including `www` not merged.
- **Coalescing needs a key rule.** For an action that takes a selection, say whether identical requests share a run and different ones run separately or get 409. A constant key silently dropped a second selection.
- **Absent versus failed reads.** For discovery from an outside source (robots.txt), say what "unreachable" keeps versus what "404" removes, so a transient failure cannot delete stored records.
- **Dependent UI actions.** When a data column needs a user action to fill (Bing status), the task names the control that triggers it; otherwise the column is unreachable.
- **Dark mode.** If the approved direction is "theme tokens only", say whether Tailwind palette classes with `dark:` variants satisfy it; the test only checks for hard-coded hex.

## Tabs with list, group and filter levels (10.008 Keywords)

When a feature shows rows at two levels (groups and members), the spec must state:
- **Which filters apply at each level.** A member-level filter (status) either narrows group sums or is ignored by them; say which, and that the row count may then differ from the expanded list.
- **Empty groups.** Whether a group with no members or no data shows 0 or null for each metric; the test plan and the docs must use the same answer.
- **Operations that merge or move pinned or hand-edited items.** Whether pins survive a merge, and who may later move them.
- **Numeric limits the spec omits** (name length, import rows and bytes, batch size, per-run cap, proposal count, value ceilings): ask the person for them at planning, or list them as named constants with the chosen values in the plan so Development does not invent them.
- **Where a setting lives.** If a feature needs a new setting (e.g. language and location), name the screen and the field in planning; a mockup that shows only a pointer is not enough.
- **Mockup placeholders.** Mark numbers and controls in a mockup as illustrative or binding; a row menu versus inline tools is a binding choice if tests rely on it.

## Board placement from provider state (10.022 precedent)

A task that moves cards between board rows from an external reading (a PR state, a merge state) must also give:
- **Reading storage and lifetime.** Where the last reading is stored (plan item field), what an absent value means (never read), and that a failed reading never overwrites it.
- **Lookup limits as numbers.** Batch size, per-project budget per refresh, spacing, and the order of who is read first. Current values: 20 per call, 100 per refresh, 250 ms, never-read first (`pullRequestStateService.ts`). Do not leave them to Development.
- **"Newest" and "ties".** Newest PR = highest number from this repository; ties by ascending numeric planning task number.
- **Which tasks are read.** Say whether Auto-merge-on tasks are read (they are not; their daemon state decides) and who wins when the two disagree.
- **Interleaving with existing row order.** State the order of old and new rows in the same row.
- **Item status versus run status.** A run can be `completed` while the item is not yet `done`. Say which one decides placement and that the card's tag and actions use the same one. Every place that renders the card (board row, Completed list, details header, PR tab, footer) must call one placement helper (`completedAutoMergeHold`).
- **Manual checks.** The real-browser move and the real `gh` answers need an owner; Development and Code Review cannot do them.

## File import features (10.009 Backlinks)

Precedent: 10.009 (rules in [seo-building](../docs/seo-building.md)). Test planning, Development and Code Review each made their own call on these, and the calls disagreed. Settle them in the task text:
- **Upload format and size cap.** State whether the file travels as base64 in JSON or as a raw body, and check the cap against the daemon's JSON body limit (25 MB). A mockup figure such as "100 MB limit" is not a requirement until it fits that limit; the delivered cap was 15 MB.
- **Two-phase import.** Say that preview saves nothing and that commit re-sends the file and recomputes (no preview token).
- **Limits as named constants.** List the chosen values for score ranges, URL, text and note lengths, extra columns, listed problems and date range in the plan.
- **Row numbers.** Say whether numbers follow the source line or the non-blank record, and whether a multi-line quoted cell is one row. Test cases and code must agree.
- **Field names the mockup implies.** Name every metric field (here linking-page DR, UR and traffic) and whether it is a table column or detail-panel only; name the preset header shapes, including a preset whose export lacks fields.
- **"New" has two meanings.** Distinguish the status "new" (first brought by the latest import) from a period view "new in period" (first seen date) in the task text.
- **Lost-link edge cases.** State what a full export with zero valid rows does, what an invalid-but-parseable row does, and what a returning link becomes.

## Crawlers and long-running runs (10.010 Internal links)

Precedent: 10.010 (rules in [seo-building](../docs/seo-building.md)). Test planning assumed these, Development chose some differently, and the person confirmed none. Settle them in the task text:
- **Limits as numbers.** Minimum, maximum and default of page cap, requests per second, timeout, page size, redirect hops, and the URL-space guard (query params, path depth, repeated segments). "Capped" is not a decision.
- **Host rule.** Name the exact setting. If the spec says "the Building's canonical host setting", grep for it; only `siteUrl` exists, and `normalizePageUrl` forces https and does not merge `www`.
- **Policies for failure and thin data.** What robots.txt 5xx or a timeout does (refuse the crawl, or crawl with a warning), what no sitemap read does, what a crawl that hits the cap is labelled, and the threshold for any "may be incomplete" flag.
- **Redirect shapes.** List every redirect form the target sites use, not just the one reported: scheme, `www.`, trailing slash, and combinations. Check how page keys are normalised (`normalizePageUrl` drops the trailing slash) against the URL actually requested, and ask what a status "complete" crawl would show if every page redirected to itself (precedent: 10.010.003).
- **Counting rules.** Duplicate links from one page to one target, nofollow links in discovery, links via a redirect, and self-links.
- **Snapshot retention.** How many snapshots are kept, whether partial ones count toward the limit, and how the Pages tab treats a partial snapshot (flag it or prefer the newest complete one). Retention is a decision, not an implementation detail.
- **Run control.** What a second start returns (status, `code`, body field naming the run; `SeoConflictError` details are only sent with a `code`), what Stop does to the item in flight (must stay queued), and whether waits (pacing, back-off) end on Stop.
- **Row classifications are decided once, on the server (10.010 Crawl log).** For any flag a table row, filter chip, summary count and warning all use ("zero links", "self-redirect", "failed"), state the exact rule (content type, error, status range) and that the server sends it as a boolean per row; the web never recomputes it. Give the summary bucket order for overlaps (failed, then redirected, then OK) and whether the buckets must add up to the requested count. Review found the web highlight drifting from the server filter.
- **Quality warnings on a finished run.** Give the threshold ("most" = strictly over 50%?), the numerator and denominator, any minimum page count, and whether it is stored at write time (old snapshots show none) or computed on read.
- **New stored per-page data needs a budget.** State per-page and total caps as numbers, what the screen says when a cap cuts data, which lists become "incomplete" (e.g. "linked from"), and where filtering, search and export run. Say which large-size cases (cap boundaries, 10,000 rows) are real tests and which are not built, so Development is not left to drop them silently.
- **Feasible cases only.** The web has no DOM harness ([testing.md](testing.md)). Mark each component case as pure helper, source pin or manual, and list the manual ones in the plan instead of writing rendered-tree cases.
- **Baseline.** Follow [Baseline verification](#baseline-verification): the first writable step runs `NODE_ENV=development npm ci --include=dev` and a fresh registered run before coding, and reports any difference from known gaps.


## Task panels that mix manual, scheduled and agent items (10.011 Tasks)

Precedent: 10.011 (rules in [seo-building](../docs/seo-building.md), "Tasks tab"). Four planning steps carried the same open assumptions into Development and review. Settle them in the task text:
- **Size.** A task with a new server model, a full web tab, more than about 80 planned test cases and docs is two tasks: server first (routes, storage, scheduler change, API tests), then web (tab, view-model, component cases). 10.011 hit the usage limit in one run and finished only after a second round.
- **Reused subsystem limits and targets.** Before choosing a limit or promising "via the scheduler", read the subsystem. The scheduler's job-name limit is 120 (plan said 200), and its targets were slot, prompt and capability only, so a scheduled code action needed a new `action` target. When a spec says "scheduled", say whether the target kind exists or the task adds it, and which shared files change (see [Jobs that start runs on their own](#jobs-that-start-runs-on-their-own)).
- **Mockup versus the capability's real input.** Mockup 4 said "attached as a document", but `start-planning-session` takes a text `prompt` of at most 10,000 characters. For any cross-Building call, open the target capability's contract in `server/src/buildings/types/` and make UI Planning match it, including the over-limit fallback.
- **Product docs that promise this task's features.** Grep `docs/` for "arrive with" / "not set up" before planning and list each line the task must change, and each promised item (here scheduled research and clustering) as in or out of scope.
- **Agent results that change data.** For each agent kind say whether the answer applies automatically or ends at approval. 10.011 chose to apply research and clustering to the Keywords tab on success; only title/meta, content and audit proposals stop at approval.
- **Error codes for derived state.** Hand-setting the status of an agent or scheduled task is 400, editing inputs of a running agent task is 409, approving with nothing accepted is 409, deleting an agent or scheduled row through the task route is 409. Default list order is newest-updated first; "today" for overdue is a plain date in the scheduler's timezone setting.
- **Worktree setup.** The writable step starts with dependency setup (see [Baseline verification](#baseline-verification)); a worktree without `node_modules` fails about 1,500 server tests.

## App-wide defaults, shared pickers and values set at start (19.001 precedent)

Development and Test Case Planning had to decide these alone; state them in the task:
- **Where app-wide state lives and what "none" does.** Name the store (daemon file or collection). For every transition to "no value" (removal with nothing to fall back on, an unknown stored id at startup) say whether an event and a notification fire and what the event carries; an event typed with a string id cannot carry null.
- **Quote existing UI text, never paraphrase it.** The spec said "6 of 7 steps" while the checklist's text is "6 of 7". Copy the string from the code or say "unchanged".
- **Name the source of reused wording.** "Existing ineligibility reason text" must name the function that holds it (`assertAutoMergeAllowed`).
- **One format for times in shared text.** When the web and the daemon both print a reset time (picker, 409, notification), pin one timezone and format. 19.001 left the web in IST and the server in UTC.
- **Id matching.** Say whether ids are trimmed or case-folded; the default is exact, so a padded id is 404, not 400.
- **Saving a switch at start.** If a value is stored when a start is accepted, say how a precondition that does not exist yet (the separate branch's run branch) is checked. The existing setter refused it, so Development added an `atStart` option.
- **Check order.** State 400, then 404, then 409 for routes with several refusals.
- **Errors in a read.** Say whether a failing side effect inside a list read (a re-check) fails the read.
- **A new default replaces every implicit fallback.** 19.001 stored the default and switched the web pickers, but four server paths kept `getDefaultExecutor()` (it returned `executors[0]`), so flows with no picker (testing setup, the docs bootstrap, the scheduler's usage gate) ignored it: bug 19.001.001. Grep the server for the old fallback (the function, `[0]`, a trailing `?? await`) and list each hit as switched or out of scope.
- **"Consider calling X" is a decision to make.** Bug 19.001.001 said "consider calling `defaultExecutor.recheck()`". A re-check reads every agent's real quota (usage pollers, OS keychain), which `WorkerManagerDeps` forbids in tests, and its pick depends on the machine. Name the side effects of a suggested call, then say yes or no; for yes, say how test harnesses inject it. Shipped: the start-path helper never re-checks.
- **Name the test seam and the test file.** A daemon singleton wired at import (`scheduler/index.ts` loads the real worker manager) cannot be tested directly; name the pure function to extract (shipped: `scheduler/defaultAgentUsage.ts`). A docs-bootstrap case needs the docs-skill Catalog fixture that only `server/tests/gitProjects.test.ts` installs, so say which file a new case goes in.

## Reports and period comparisons over stored history (10.012 Reports)

Precedent: 10.012; rules in [seo-building](../docs/seo-building.md), "Reports tab". Planning, Development and both review rounds each hit the same missing decision.
- **History that is not stored yet.** For every "changed between two dates" metric (newly indexed, internal-link changes), check what the code keeps today: `seo_inspections` holds only the latest state per URL, while the crawl keeps its last 10 complete snapshots. Say which history the task adds, and the three rules that follow: how a Building with existing data gets a baseline, what a first answer means (a baseline, never a change), and that a period ending before the earliest known state shows "no data" with a note, never a real 0 with a "better" delta.
- **Check the mockup's dates against the stated rules.** Sample ranges that start on a non-Monday, include today, or count days the default rules exclude are mockup errors; say so in the task and pin the clock the tests use.
- **Pin the open numbers in the task:** default minimum impressions and whether it applies to both periods, list caps, name limit, treatment of a link both new and lost, DR/UR averaged per link or per domain, overlapping comparison ranges, and whether the published event fires for manual saves or scheduled ones only.
- **"Scheduler absent".** Name the test (`scheduler.isRunning()`), and say what a scheduled run on an empty Building and a repeated run for one period do.
- **Do not widen a docs edit.** A step that rewrites a "known gaps" line must keep the other entries; 10.012 Development dropped the 10.010.001 line while adding its own.

## Reopening or re-running finished work (22.001 Report regression)

Planning, UI Planning, Test Case Planning, Development and Code Review all hit the same spec conflict and open choices.
- **Reused dialogs: say which controls are dropped.** "Same agent choices as the Start task dialog" was rejected in UI Planning; a re-run that resumes earlier sessions reuses each step's earlier agent and offers no choice. When a re-run resumes prior state, say whether the person picks agents, and read the closest existing dialog (`RejectStepDialog`) before specifying the form.
- **Pin the wire contract.** Name: the field and its value for legacy records (`[]` on the wire, absent in storage), the reporter shape (structured `{ kind, sessionNumber }`, label derived in the UI), the timestamp format (ISO), whether the length limit counts before or after trimming, the success status (201 for a new run), the error body (`{ error }`) and whether leftover optional inputs (`executorId`) are ignored or refused.
- **"Refused start" has two phases.** A refusal before the run is accepted (cap, folder busy, no agent) records nothing; a start-up failure after acceptance ends the run Failed with the record already written. Say which cases belong to which, and which refusals the test environment can reach.
- **Say what stays visible of earlier rounds.** When a new run replaces the view of a bug's work, state how the earlier run's rounds remain reachable (read-only) instead of leaving it to Development.
- **Cross-directory resume is unverifiable here.** Resuming a session from another working directory needs the real CLI; list it as a manual check owned by the person and in the product doc's open limits.

## New per-step workflow options (precedent: 22.002 "Can run commands")

A task that adds a permission-like option to a workflow step (beside `canEditCode`) must settle these in the task text, not leave them to Development or Code Review:
- **Every launch path.** Interactive step sessions, the reopened-session choice (does a settled step with only this option offer "with permissions or read-only", and what each mode grants), retry/resume snapshots, and the headless CLI path (`runCodexTurn` is only the plan titler, Complete summarizer and SEO agent; workflow steps never reach it). Name what each path gets: tools denied, MCP servers, sandbox flag.
- **Sandbox facts as facts.** If the option needs network or a wider sandbox on Codex, state the exact flag or mark it "unverified, Development confirms" (22.002's `sandbox_workspace_write.network_access=true` is still unverified).
- **Interplay with the sibling option** (both on: stays on, disabled, or hidden) and **which neighbouring tools follow it** (`report_unrelated_test_failure` shares `testingToolsAllowed`).
- **Stored data.** Any new field on a stored record (`sessionSetup`) and how a legacy record without it reads.
- **Options that add an MCP server or external tool (39.002 `canUseBrowser`).** Decide in the task text, not in test-plan assumptions: the exact tool allow-list (an enumerated list, since `McpServerLaunch.tools` has no wildcard, and which of the server's tools are deliberately left out); whether `null` is rejected like other non-booleans; whether a testing-setup run may get it (shipped: never); when availability is probed (at session launch, never at catalog save) and how a missing install reads; and the cleanup mechanism. Workflow steps run as interactive PTY terminals, so cleanup belongs to `terminalSessionManager` and `commands/processGroup.ts`, not a command runner.
- **Name the injection seam for every environment probe.** A probe of the real machine (installed package, browser binary) must be an injectable dep of `createWorkerManager`, and the plan must say the probe runs once per launch with its result shared by the prompt and the session servers. Without that, the "unavailable" path can only be tested by branching on the real install (39.002 round 1).
- **Web cases are pure helpers.** The web suite has no DOM harness. Plans for a new badge or switch name the pure helper to extract (eligibility, badge list, form mapping) and list rendered states as manual checks.
- **Mandatory tests.** Mark which planned cases are required. Each acceptance criterion needs a named test (22.002 criterion 4, no commit/push and a lockfile change not failing the run, was first missing and cost a review round). "Reuses an unchanged path" is an acceptable reason to drop a case only if the task or test plan says so up front.
- **Web editor round-trip.** `toWorkflowStep` in `web/src/lib/workflowForm.ts` rebuilds each step from its form fields, so a new step field must go through `StepFields`, `emptyStep`, `stepFromRecord` and `toWorkflowStep` (with a round-trip test), or one Catalog editor save erases it. Name this in the task; in B.036 only the RCA caught it.
- **An output the step must produce is enforced at `complete_step`, not in prose (B.036).** Use a step field checked before anything is recorded (`requiredOutputFormat`, `server/src/worker/requiredOutputs.ts`), so a refusal is a tool error the agent retries in the same session. Also read generic prompt text every step of that kind gets (`buildStepPrompt`'s Permissions section) against the step's own instructions: "cannot create any file" sent about 16 UI Planning rounds to approval with no mockup.

## Persisted drafts and inline forms (22.004)

- **Name the limit or drop the sentence.** "The limit that exists today" must name the function, route or constant. If grep finds none (22.004: a rejection reason has no length limit in web or in `/workflow-runs/:id/request-changes`, only a blank check), say "none" and state what a refused send can only be (blank, body-size limit).
- **Pin the storage key and cases.** Say what the draft is keyed by (run id, URL-encoded), the key prefix style (`createDraftStore` in `web/src/lib/draftStorage.ts`), whether it saves per keystroke, and that Ctrl/Cmd+Enter is ignored during IME composition.
- **State the in-memory reset.** A draft cleared from storage when a run leaves its state also needs the in-memory text and the expanded flag reset, because the component stays mounted (keyed by run id). Say both, or a re-entered state reopens with stale text.
- **Compact-start textareas.** A shared auto-grow textarea must set `rows={1}`; the browser default of 2 rows sets a 2-line floor. Pin the starting line count of each user (1 for rejection, 2 for loop comment).
- **Worktree install state.** A fresh worktree may lack `node_modules` (22.004: `zustand`, `node-pty` missing, so 39 web failures and 1658 server failures). Follow [Baseline verification](#baseline-verification): dependency setup is an explicit first step, and a bulk-failing baseline is reported, not accepted as "known gaps".

## App-wide restyles and design-system tasks

- **Count the real surface, not the brief's estimate.** Grep the colour rule over `web/src/` (see [design language](../docs/design-language.md#the-colour-rule)) before writing "about 11 hard-coded colours"; the 21.x redesign found about 313. State the counted sites and which directories the sweep covers (`ui/`, `components/`, `lib/` class strings, canvas libraries).
- **Brief items with no backing data get a decision up front.** For each part of a reference design that needs data the API lacks (counts on drop zones, invoice sheet, stage-advance button, a time series for a line chart), write in the task whether to build it with a stated stand-in, drop it, or ask the person. Do not leave it to Development, which can only defer and ask afterwards.
- **Say how far a Building's tabs are rebuilt.** Separate "shell: `PageHeader`, KPI row, tokens" from "each tab body rebuilt as cards". Name which dense views keep their layout.
- **Test environment for components.** The web has a static `react-dom/server` render path, not a DOM ([testing.md](testing.md#writing-web-tests)). Word component cases as markup assertions, put interaction rules in pure functions, and list drag, motion and blur as manual checks. Scope "100% / below 90%" to new and changed files.
- **Fixed defaults to state in the task:** an unknown stage falls back to the first column; invalid scores clamp to 0; view toggles (Board/List, Grid/Table) are not persisted; the stage-to-accent mapping when stages outnumber accents.

## Disabled buttons and shared form controls (21.001.001 precedent)

- **A control that gates on state shows why.** Disabled buttons hide their `title`, so a task that gates an action on prior steps (preview, mapping, loaded file) specifies it enabled, with a click-time message in the tab's existing error note, listing each blocking condition and its order. Disable only for read-only or busy.
- **Changing a shared control's layout names every parent kind.** Before editing `NativeSelect`-like wrappers, list the callers by parent (grid cell, flex row, fixed width) and state which rule sizes the wrapper and which sizes the select. Static-markup tests prove classes only; a browser check is the real acceptance.

## Large multi-section Building types (21.001 CRM precedent)

- **Name every spec word that picks behaviour.** Define "cold" (which messages get an opt-out footer), when a chain "ends", and whether coverage is judged per file or overall, in the task. 21.001 left these open and Development pinned them in [docs/crm-building.md](../docs/crm-building.md).
- **Say which status code each limit uses.** Duplicate name versus the Nth item over a cap (409 vs 400), a Building of the wrong Type (404), and the notification kind, severity and subject type for a connection fault.
- **Size uploads against the transport.** A 20 MB file as base64 JSON exceeds the 25 MB daemon limit; state raw/multipart upload for files and base64 only where it fits.
- **GET routes are pure reads.** If time-driven work (sends, ticks) must run when a view opens, specify an explicit POST, not a side effect of GET.
- **Baseline wording.** Use the measured failure list of a fresh run, not only the known-gaps list; unlisted baseline failures and a `tsc` error should be listed in [testing.md](testing.md#known-gaps) or fixed by a separate task. Planning cannot run suites, and the registered server run may not finish: say direct runs of the same commands are acceptable evidence when it does not, and that tests must not write to the real data folder (`dependencyGit.test.ts` leaves `projects/dependency-git`).
- **Deliver mockups in small batches.** One large payload per step call fails to parse; send a few files at a time. Ask for light theme only when the app has no dark theme.

## Features driven by task or run lifecycle events (24.001 CRM work updates)

- **Name the hook point and the task identity.** Say where start/finish events come from (24.001 hooks `syncPlanItemForRun` in `workerManager.ts`) and that a task is its plan item id, so retry and resume share one identity. Planning left both to Development.
- **Say which runs count as task work.** Testing-setup and PR-conflict runs are not customer work (`isCustomerWorkRun` in `server/src/crm/runtime.ts`). Live posting and any backfill must use one shared predicate; 24.001's backfill missed it until Code Review.
- **State the "started" rule for retries** (first run only, and only if attached when it was created) and the caps, timeout, generic label and date-boundary inclusivity, instead of leaving them as assumptions.
- **Baseline wording when registered runs may not finish.** Registered runs have stayed `queued` or timed out after 15 minutes, and the full direct server run stalls in the SEO API tests. Write the criterion as: "no new failures versus a direct run of the starting revision (CRM files plus web) if the registered runs do not finish", and require the stall to be reported.

## Scope decisions and mockups (24.002)

- **A task that fixes a scope ("panels already smaller stay unchanged") is a UI Planning input.** Copy the unchanged set into the UI Planning brief as "draw as today", so the mockup cannot show it at the new value. 24.002's round-2 mockup drew 18px menus, selects and popovers at 24px against the task and had to be overruled in Test Case Planning.
- **A revert request rebuilds from the approved mockup.** When a round only changes one element ("chart tip as before"), say in the brief that every other section stays as approved and name the file to start from.
- **Audit-record criteria list both sides.** Word it "the doc lists the changed places and the intentional exceptions", not only "changed places", when a review may carve out an exception.
- **Unpinned visuals are named.** If padding or spacing is left unpinned by choice, say so in the task and list it as a manual check with an owner.

## New session kinds and user-named records

Precedent: the Agent terminal sessions task (current behaviour in [architecture](../docs/architecture.md#agent-terminal-sessions-an-interactive-coding-agent-per-project-not-a-task)). Test planning and Development each had to guess these, so the task states them:
- **Name rules.** Maximum length (80, trimmed), whether empty is refused, control characters, and that the agent-facing path and the manual rename share one validation.
- **Agent-facing tool auth.** Which token and which id authenticate the call (the CLI hook token plus the session id), and the status per refusal (400 bad name, 401 or 403 bad token, 404 unknown or out-of-project session), using `{ error }` bodies.
- **Restart behaviour.** What a record left running at daemon restart shows (ended, with resume as the way back) and what resume does when the agent no longer has the conversation (fresh start, same name).
- **Exposure to the web.** Which stored fields the web record carries; agent conversation id, environment, token and folder path stay server-side unless the task says otherwise.
- **Which app tools the session gets.** List them by name (task, testing, bug, commands, start). "Whatever the app already exposes" is not a list; the Agent session task asked for bugs, starting tasks and commands and got a subset, and the gap was only found in review.

## Merging or replacing session kinds, and new agent tools on an existing route family (27.001 Plan & bugs)

Precedent: 27.001 merged Plan and Report bug into one session kind and added `set_dependencies`. Test planning, Development and review each assumed the items below. Current rules: [Unified Planning board](../docs/unified-planning-board.md), [Dependent tasks](../docs/dependent-tasks.md#bugs-and-the-plan--bugs-session).
- **Retiring a creation path.** Say how the old kinds are refused (route removed: 404, or 400/410), which route now starts the new kind (the chat route), and that follow-ups and resumes keep the kind they continue (`continueTask` copies `planningPurpose`).
- **Which kinds may call which tool routes.** List per session kind (new, earlier bug report, plain planning) and give the status for the others (409 for a wrong kind). "Same tools as today plus X" does not say whether X is open to the old kinds.
- **Server-side eligibility.** When a rule exists only in a web picker (parent eligibility: `parentState`), say whether the agent tool enforces it on the server and with which status (409), and that the person's own route keeps its looser rule. A check-then-write pair must run inside the per-project exclusive queue (`dependencyService.setDependencies` with `requireEligibleParents`): a start landing between them is the race review found. State that the set-versus-start race is tested in sequence, because real concurrency is not reachable in tests.
- **Counts a new kind inherits.** Does the lifetime "created" counter (`planningCreatedTaskCount`) count bugs, and what arms auto-completion ("after its first item", either kind).
- **Manual completion with two kinds.** Say whether standalone ready bugs are released with the tasks (yes, by `linkedSessionNumber`; bugs under an introducing-task card keep that card's slot) while earlier bug report sessions leave bugs alone (`bugTracker` I41-I43).
- **Capability tool.** Say whether the new kind gets the outgoing-links tool (as planning does) or not (as the bug report kind).
- **Button labels that go with a mixed kind.** A button that acts on one kind only (Chain tasks) says so in its label.
- **Baseline in a fresh worktree.** The worktree has no `node_modules`; the first writable step installs dependencies in `server/` and `web/` before measuring. The registered server run can reach its 15-minute limit in the SEO tests, so name the per-file fallback.

## Detect-and-suggest features (31.001 CRM paste import)

Precedent: 31.001 (current rules in [crm-building](../docs/crm-building.md#import-import-tab)). UI Planning, Test Case Planning and Development each had to settle these:
- **Reused controls have a direction.** CSV's `ColumnSelect` is one select per field that picks a column; "a role select per column" is the opposite. Name the reused control and say which direction the new screen uses.
- **Every override re-runs the suggestion on the server.** If the owner can change a detected value (separator, header row), the suggest route takes it as an optional input; list those inputs with their wire names (`'tab' | 'comma' | …`, case-sensitive) and the 400 for anything else.
- **The response carries what the mockup shows.** After UI Planning, check the suggest response against every badge and count in the mockup (31.001 needed `rows` and `columns[].byAgent` added by Development).
- **"Allowed on a read-only Building" names both sides.** Say what the web does there, and that the server route must be added to `MUTATION_EXEMPT` in `readOnlyGuard` (`server/src/api/buildingRoutes.ts`), which otherwise refuses every POST with 409.
- **Say whether the new flow inherits the old flow's gates.** Paste used to import without a preview; state whether it now needs one (`commitBlocker`) and give preview/commit status codes (200/201 as CSV).
- **"Reuse X" names a signature that exists.** The task said to reuse `readHeaders` and the CSV parser; neither took a separator. Name the function to extend (here `csvRecords(text, separator)`) or say the web gets columns from the server.
- **State the fallback rules the test plan would otherwise assume:** row width mismatch reason, tie order, header refusal messages, sample counts, strict agent JSON (no fence stripping), injectable timeout, and the rule for a body sending both the old and new shapes.

## Controls that depend on an item's type or state (21.001.004)

The task named three screens, but a fourth path (Prospects "Pending reachout" flag, its click handler and the KPI, from server `PENDING_SQL`) had the same defect and was found only in RCA review. When a bug is "control X shows for the wrong item type or state":
- List every consumer of that rule before scoping: grep the type or state in `web/src/ui/` and the server SQL that feeds flags and counts, not only the screens in the report.
- Name one shared helper (`web/src/lib/crmCalendar.ts` for CRM item types) and a source-check test that no screen keeps a local type set.
- **Time-zone bugs (21.001.005):** grep `web/src/lib/`, `web/src/ui/<feature>/` and `server/src/<feature>/` for `toISOString().slice`, `timeZone: 'UTC'`, `?? 'UTC'` and `= 'UTC'` defaults, and server text built with `toISOString()`. Allowed uses are API payloads and input values (see [Shared formatters](#shared-formatters-and-use-it-everywhere-tasks-31002-relativetime)); every other hit is a site. A `datetime-local` default needs local date parts, not `toISOString().slice(0, 16)`.

## Suppressing or deferring an attention state (B.015 precedent)

- **Name what must never be suppressed.** When a task changes when a CLI hook raises "Needs attention", list the hook kinds that stay real questions (`PermissionRequest`, `permission_prompt`, `agent_needs_input`, `Interrupt`) and which ones may be covered (`Stop`, `idle_prompt`).
- **Decide what a deferral compares and what a restart does.** A deferred alarm needs a re-check rule, a rule for the hook arriving just after the awaited work ended, and a restart rule (the CLI is dead, so clear it; never raise attention). Do not prescribe a timestamp comparison with the awaited work's end: a late hook is newer than it and would swallow the alarm. Name which ids count as awaited, since a joined run can belong to another task.

## Shared formatters and "use it everywhere" tasks (31.002 RelativeTime)

Precedent: 31.002 (current rule in [design language](../docs/design-language.md#components)). UI Planning, Test Case Planning and Development each had to settle these:
- **Give the full band table for a time formatter.** Every edge on both sides, plus the crossings: does tomorrow 10:00 seen at 15:00 read "in 19h" or "tomorrow" (31.002: hours under 24h, calendar day from 24h on), and what a 25-hour daylight-saving day gives (never "0d").
- **State the refusals.** What an unreadable instant (bad ISO, NaN, past the Date range) and an unknown time zone do. 31.002 chose `''` / render nothing and lets `Intl`'s `RangeError` through.
- **"Existing outputs stay the same" needs a grep of the tests.** Search the tests for the behaviour being changed before saying they keep passing. Three tests asserted the old future clamp ("just now") and had to be rewritten after the person decided.
- **Check each call site's inputs.** For "use component X at every site", say per site where its inputs come from (`ReachoutPopup` hard-coded `'UTC'`, and `NotesTab`/`LostTab` had no settings load) and whether it takes a React node or only a string (`TaskRows` `summary` keeps the pure function).
- **A source-check ban lists its allowed uses.** "No `toISOString` for display" needed an allowlist for API payloads and input values (`ResponseForm.tsx`, `ContactPanel.tsx`).
- **"One X per page" names a testable seam.** A shared timer or store is a module with subscribe and current-value functions, so the rule can be proved without a DOM (`web/src/lib/minuteTicker.ts`).
- **Mockups use the code's locale and pinned instants.** The mockup used `en-US` while the code uses the browser default. Test fixtures that quote mockup values must copy the mockup's own "now" instant; the test plan's F11/F12 used a different instant, and the expected values did not hold for it.

## Session panes tied to a record's state (32.002 Content Studio Script tab)

Test planning and Development had to decide these alone; state them in the task:
- **A "link to X" needs a target that exists.** The global Settings panel and the default-agent control open only from the top bar and footer (local state), so a Building cannot link to them. Say "plain text pointing to the footer dot" or make opening them a task item (a store action).
- **State what each pane shows right after a state change.** After Reopen the right pane is empty until the agent saves (the finalized text goes to the agent only) and Finalize stays disabled until then; say it, with the draft label and the empty text.
- **Race tests.** Operations that run in a Building's write queue (`ctx.exclusive`) cannot interleave, so a forced-hook race case (finalize versus `save_draft`, two starts) is not reachable. List them as "fire together, accept either legal outcome" and name the queue as the guarantee. This extends the rule in [New session kinds](#merging-or-replacing-session-kinds-and-new-agent-tools-on-an-existing-route-family-27001-plan--bugs).
- **Contract choices to write down:** setting path limit and `~` (not expanded), empty/null clears to the default; whether stored text is trimmed; new-round, resume and start on a finalized asset (409) and with no agent (409, round untouched); what deleting a Concept or Building does to its sessions and drafts (ends and removes); the exact `/ws` event name; and that a view counter sent to the web must survive a daemon restart (the web drops "older" views).
- **Baseline.** List intermittent server cases seen on the fresh run (`waitingList` start-at-limit, `seoPagesSitemapsApi` I24) as "pass alone", per [Baseline verification](#baseline-verification).
- **An interactive agent session needs a first message.** Launching a CLI with only a system prompt leaves it idle (32.002 shipped this way). For any task that starts an agent pane, state what the first user message is per kind, and which starts get none (resume, reopen). Test the prompt passed to the host, not only that a session started.

## Features with agent extraction, publish and stats rules (32.003 Content Studio)

Test planning and Development decided these alone; state them in the task:
- **Agent failure answer.** Say the status and body for a failed one-shot extraction (200 `{ ok:false, reason }` keeps the form usable), plus extraction on a non-published post (409), text-only input (valid), and an image over its limit but inside the body window (400).
- **Body window.** Give the number for the 413 (here 10 images plus 2 MB, about 102 MB buffered in memory), not "the route's window".
- **Rules that read another record's state.** Say which asset kinds a published post blocks from Reopen (script never), what editing the published time does to existing snapshots (400), and that Unpublish clears URL and time but keeps stats and sources.
- **Sort keys.** Name the field a derived sort uses when platforms label it differently ("Most views": `views`, falling back to `impressions` for X) and how a parent with several children sorts.
- **Missing limits.** Give an upper bound for each numeric field (watch time) and say whether a lower bound exists.
- **Agent kind.** A task that runs the default coding agent says what happens for a kind that is not Claude or Codex CLI; the guard is easy to miss because 32.002's lives in a closure.
- **Routes with no reachable caller yet.** If only one tab has an agent pane, say which route-level cases (reopen 409, publish-vs-reopen race) are tested on the guard function only.
- **Baseline.** The measured 15 server `tsc` errors and the intermittent server cases (`SI29`, `two frees at once`, `waitingList` start-at-limit, B.019) belong in the task's expected list; link [testing known gaps](testing.md#known-gaps).

## Per-item tabs with limits and a default selection (32.004 Content Studio post tabs)

Every step after planning flagged one of these; state them in the task:
- **A default selection says when it is computed.** "Opens on the first post that is not finalized" was recomputed on every render, so finalizing the shown text jumped to the next post and auto-started its session (Code Review, major). Say "chosen once when the view opens; a deleted item falls back to the default", and name the remount paths that reset it (here each tab keeps its own: `PostTextTab` is keyed by tab), per [Scope "lasts while the popup stays open"](#scope-lasts-while-the-popup-stays-open-across-every-remount-path).
- **A text format with a limit gives its parse rule.** For a split or counted format, state the character unit (code points), separator tolerance (spaces, tabs, `\r`), what happens to empty parts (dropped or refused), the exact pattern for counted tokens (hashtag `#[\p{L}\p{N}_]+`), and any title or minimum rule. 32.004 left all four open; the person settled them in Test Case Planning. The current rules are in [content-studio-building](../docs/content-studio-building.md#platform-limits).
- **A new limit is checked against the caps already in code.** Grep the existing validator before writing a number: Facebook's 63,206 sat above the generic 50,000 draft cap, so the task had to say which wins (the platform limit).
- **"Give the agent the path to X" names a file that exists.** Say who writes it, when it is removed, and what existing data (finalized before the task) gets. 32.004's finalized script lived only in the database; `script/script.md` was decided mid-run, and old finalized scripts have no file until reopened.
- **Say what a view shows when its rule turns false while open.** A tab that becomes disabled while shown (its last post deleted) and a counter over its limit on stale data needed wording from Development ("the disabled reason", "Over the limit by N").
- **Session context is a snapshot.** Say whether the instructions (other items' states, linked files) are read once at session start or kept live; refusal bodies follow the house shape 400 `{ error, field }` with a message the agent can act on.

## Background processes the person opens in the app (32.008 Remotion Studio)

Every later step had to decide these; state them in the task:
- **Every stop path and what the view says after it.** Where Stop lives (footer only, or next to the view too), whether the state carries a stop reason (Stop, idle, deletion, crash) or the stopped text stays generic, and whether reopening or a page becoming visible restarts it (32.008: Stop in both places, generic text, no restart by itself, **Start Studio**).
- **The full view shape and event name.** The GET body (`{ state, url, error, log, waitingForSetup }`), whether "waiting for setup" is its own state, which field enables a tab (a new Concept view field such as `compositionId`, since nothing exposed it), the `/ws` event, and the job kind in the footer.
- **Numbers.** Log cap per process and per line, start timeout, idle limit, client heartbeat interval (below the idle limit) and the rate of log-only events. The registry's 1-second progress throttle (`PROGRESS_INTERVAL_MS`) holds back state changes unless they are sent at once; say they are.
- **Who waits for a prerequisite** (an install) and what a heartbeat, GET or Concept deletion does to the process (nothing, no timer reset, keeps running).
- **Read-only exemptions name the guard.** A read-only Building refuses every POST in the global guard (`buildingRoutes.ts`), so "start and stop are allowed when read-only" means adding those routes to its exemption list. Also say whether a tool that writes files by itself (Studio's prop saves, its own Render button) is acceptable on a read-only Building or in a "renders only in the Video tab" rule.
- **Footer Stop by job kind.** The running list's Stop called `stopRender` for every content row; a new kind must say which route its Stop calls.
- **Orphans.** Say what happens to a child in its own process group when the daemon is killed without its `exit` handler (SIGKILL): accepted and documented, or cleaned up at the next start.

## Agent tools that block, typed input and media files (32.007 Content Studio Video tab)

Every later step had to decide these; state them in the task:
- **Tool calls longer than 5 minutes.** Node's global `fetch` gives up after 300 s without response headers, whatever its abort signal says, and a real CLI has its own tool-call timeout. For a tool that "returns when done" (a render, a crawl), pick the mechanism: a blocking call over the long-call transport (`requestDaemonLong` in `server/bin/lib/mcp-stdio.mjs`, used above `FETCH_SAFE_MS`), heartbeats, or start-then-poll. Name the test proxy, because fakes never reach the limit, and list the real-CLI check as manual.
- **Text typed into an agent's terminal.** Name `typeIntoSession` (`server/src/content/typeIntoSession.ts`): one bracketed paste, a delay, then a separate `\r`. Never plan a raw `host.write` of the text: 36.002 followed the old "text, then `\r`" rule and a message over 1,024 bytes reached Claude Code cut (bug 36.002.001). Say that the text is one line (refuse newlines in fields it quotes), what happens when the session has ended (409, not queued for resume), and what the response can honestly report (nothing from the CLI confirms delivery; 36.002.001 returns `sentChars`; Claude Code queues a mid-turn paste, Codex is unchecked). Write test cases against the exact write sequence, and list a real-CLI paste over 1,024 bytes as a required manual check, because a fake host cannot show what the CLI submits.
- **A size cap states its unit, its purpose and the largest input it must hold.** 36.002.001 asked for "about 500 characters" while the comment it must keep whole allows 2,000 code points and lines may be Devanagari (3 bytes a character), so no character cap could keep the message under one terminal read. Say bytes or code points, whether the cap is the fix or only extra protection (there: bracketed paste is the fix, a 500-byte cap is protection), and which part is never cut.
- **Files the person names.** Say whether the extension is editable (no: fixed suffix), where rename happens when the list is narrow, what an upload with a bad or taken name does (clean and suffix, or refuse) versus a rename (refuse 400/409), case sensitivity, and size units (GiB). A "folder pointing at X" names the mechanism (symlink, or the path given to the agent).
- **Every failure state names its recovery.** A setup failure needs a retry action and its route (here a repeat `POST session`).
- **Finishing while background work runs.** Say whether Finalize, Discard and delete are refused (409), wait, or stop the job, and whether that holds for a queued job too. Say what a deleted file does to links in earlier rounds.
- **Tools on a shared session server.** Give the status when another tab's session calls them (409), the accepted values of every option (`codec`: `h264` only, else 400), and what Reopen copies (checklist ticked but not confirmed).
- **Ids derived from a prefix.** A short id cut from a UUID (`concept-<8 hex>`) can collide; say how ids stay distinct.
- **Media serving.** Range requests for any file a player shows, and SVG served sandboxed.
- **Work that needs a tool installed later.** Thumbnails from Remotion's ffprobe cannot run before the project install; say when media dropped earlier is processed.
- **Dialog component cases.** Radix dialogs portal and do not render statically. Say whether a dialog case covers its body (exported and rendered alone) or the open dialog in a browser.

## A second tab reusing another tab's project, queue or jobs (32.006 Content Studio Images tab)

Every later step had to decide these, and one reached Code Review as a major bug; state them in the task:
- **Shared folders: check every operation that already works on the whole folder.** 32.006 put stills inside the Concept's code folder (`src/concepts/<cid>/images/`), which 32.007's video "Start a new session" archived, restored with `rm -rf` and gave to the video agent to edit. List each existing archive, restore, remove and agent edit-scope operation on the folder and say how it treats the new subfolder, or put the new files under a separate root. The current rule is in [content-studio-building](../docs/content-studio-building.md#images-tab-task-32006).
- **Shared queues: name the side effects across tabs.** A "stop every render of this Concept" written for one tab now stops the other tab's jobs. Say which stops are per asset and which are per Concept, which stop route the footer calls for each job kind, and how limits inside one job (60 s per image, 5 min per call) work when the queue has one timeout per job.
- **A call that makes several outputs.** Say when the old output is cleared (when the call is accepted, or only on success), whether outputs from a stopped or failed call stay visible, and whether they count toward Finalize. 32.006 left all three open; UI Planning assumed them and the person confirmed them in Test Case Planning.
- **Inputs of a list tool.** Give the status for duplicate ids, how the daemon knows which ids belong to the item (here: the files in its folder), the composition id scheme, what a missing optional size does (each side falls back on its own), a second call while one is queued (409), the line and length limits of any text the tool saves, and file naming (zero-padded, so 10 sorts after 9).
- **Third-party CLI options nobody has run.** When the mechanism comes from documentation (here `remotion still --width --height` on a one-frame registered composition), say so in the task and list a real run as a manual check.
- **Mockup toggles are not a code rule.** Mockups toggle with inline `style.display`; React code renders conditionally. Do not turn a mockup convention into a test case.

## Agent-proposed changes the owner reviews (32.005 Writing-style retro)

Every step had to settle these; four steps raised gaps. State them in the task:
- **Each UI state names its read path.** For every status a view shows (the last retro of one asset), name the route or view field that returns it. 32.005 listed only list routes, so the per-asset status needed a new `retro` field on the studio view.
- **Answer parsing rules in full.** For a strict agent answer: whitespace around it, case sensitivity of enum values, how a `find` is counted (overlaps, heading excluded, scoped to its section), which fields each action forbids, and whether `text` may contain a heading line (`## `) that would split the document.
- **Edit and apply semantics.** What Edit may change (here `find` and `text` only), where an `add` lands (end of section), what `remove` of a whole line does with its newline, and the change order.
- **Write and refusal shapes.** Storage tables, the accept body (excludes, edits, which wins), the 409 body listing failed items, what accept and discard return, the run route's 202, the setting key and its accepted values.
- **Every outcome of the background record.** Its status set including after a discard, a finalize while one is still running, a daemon restart mid-run, the Concept or Building deleted mid-run, zero inputs (skip).
- **Which views refresh after each path.** Name the `/ws` event and what the web refetches, for a manual apply and for an automatic one. 32.005 covered only the manual accept, so an auto-apply leaves an open editor stale (a known gap in [content-studio-building](../docs/content-studio-building.md#writing-style-retro)).
- **A trigger for kinds with no route yet** is a shared hook that later tasks must call; say so, and that tests drive it directly (extends [Building tasks that leave behaviour "open"](#building-tasks-that-leave-behaviour-open-32001-content-studio-precedent)).

## Village visuals fed by test or run results (33.004 test-health wall)

Four development and review rounds went to data questions the task left open. State these in the task:
- **Data source.** The world store (`testRunsById`) holds only live, running and unopened-failed runs, not suite config (enabled flag, primary action) or the latest passed runs. Name the fetch (`getTestingOverview` plus `listTestRuns`, as `useTestHealth` does) instead of "use the store".
- **Selection rule.** "Same as the Testing tab" means `suiteResults` and `tallyResults` in `web/src/lib/testingPanel.ts` (enabled suites, primary action); say what changes (here only the branch filter). The own-tree test is `executionRoot` equal to the overview root, not `taskId`.
- **Metric and aggregate choices.** Which metric (`line-coverage` first), its unit (percent), newest or oldest `completedAt` across suites, and the look when counts are missing or all skipped.
- **Geometry against the roof.** A piece that sits on the building edge at eave height may cut through the sloped roof, and corners need a joint rule. Ask for the visual check in the task's manual list, since no one can render it in a worktree.
- **Name the host and one footprint.** Say which scene component draws a piece (the yard group, not a building inside it, so it turns with the yard) and give one outline with its exact numbers. 33.004 said both "ring over `YARD_RECT`" and "on the existing fence", which sit `FENCE_MARGIN / YARD_SCALE` (0.48 yard units) apart, and put the wall on the warehouse, so bugfix 33.004.001 was needed. Take the outline from the existing object it must match (`FENCE_MARGIN`, `FENCE_HEIGHT` in `web/src/scene/scenery.ts`), and give the wall height, its thickness and the treatment of the gate gap. A wall on a fence that has a gate is an open path, not a closed ring: it starts at one gate edge and ends at the other, and coverage is a fraction of the perimeter minus the gate (bugfix 33.004.002). Share `GATE_WIDTH` from `scenery.ts` (as `HEALTH_WALL_GATE` in `healthWallSize.ts`) instead of copying the number, and plan a check that no piece overlaps the gate gap at several fractions. Add a check that the piece is taller than that object, and that it takes no clicks (`raycast={noRaycast}`).
- **Shadows on stacked pieces.** When a piece sits on an existing object, say that both cast shadows (or neither) and which source test pins the choice (`villageTerrain` C13 forbade fence shadows until bugfix 33.004.003). 33.004 gave the wall `castShadow` over a fence that cast none, so the wall looked afloat.

## Computed results, targets and agent-read documents (32.009 Content Studio Insights)

Every step after planning decided these alone, and Code Review raised the response shape and filter scope; state them in the task:
- **Where a computed value sits in each response.** Name the field on the post, on the Concept and on the list (`result` on each post; a per-platform `summary` over all matching Concepts, not one page), and the closed wire values of every new filter (`on-target`, `partly`, `below-target`, `too-early`, `no-target`).
- **Precedence between states.** Say which wins when two apply: no target outranks too early; all set fields with no data is Below target; a published post with no snapshot is Too early with no progress and is not counted as judged.
- **Rules that map a field to a data source per platform.** The views rule (impressions for LinkedIn and X, views elsewhere) was settled by the person in Test Case Planning and contradicted the mockup's labels. Put the table in the task and say the mockup follows it.
- **Filters that combine.** Say whether a result filter respects the platform filter (it does: only that platform's posts count).
- **Field names, limits and what a change triggers.** Name the settings field (`evaluationDays`), the notes limit (50,000), whether a target change refreshes at once (yes, coalesced with a running run) or after the debounce, what a refresh with no data does (409 "nothing to learn from"), and that Stop is not an error and keeps the previous document.
- **Time shown in a mockup.** A line like "Refreshes in about N minutes" needs a field the server exposes (`nextRefreshAt` on `GET insights`); say so or drop the line.
- **"The agent reads file X" must fit the agent's access.** A tool-less agent outside the Building folder (the retro, per 32.005) cannot open a path: say it gets a relative path plus the text inline. For a read-only headless agent, say whether its data file is inside its working folder; the real CLI's behaviour is a manual check.
- **Baseline.** Take the list from a fresh run on the starting revision and update [testing known gaps](testing.md#known-gaps) in the same task; 32.009's planning found it stale (B.019, `villageScene` C08, `villageStore` IW02, the `bugApi` load flake).

## UI tasks whose tests cannot run in the worktree (36.001 Concept page header)

Three steps raised the same gap: the worktree had no `web/node_modules`, so the new render tests never ran in Development or Review, and markup-regex assertions were wrong or unverified: the Concept header test expected lowercase `datetime=`, but React writes `dateTime=`, so it failed on `main` until bug B.029; `formatExactTime` has no year. State in the task:
- **Make dependency install a prerequisite of the writable stage**, or say render tests are unverified and must be run by the owner (see [Baseline verification](#baseline-verification)). Do not word the criterion "no new failures" over a baseline that fails only for missing dependencies.
- **Plan assertions against real output.** For text a helper formats (times, plurals), compute the expected string in the test with the same helper; for attributes, name the server-rendered spelling (React keeps the prop's camelCase, such as `dateTime=`, and `includes` is case-sensitive).
- **Interaction under `renderToStaticMarkup`.** Toggles, focus and save-on-blur cannot be driven; require an `initialX` prop seam for the open state and list the rest as a manual browser check. A rule that depends on when a click happens (Retry reads the latest choice, a value changed while a start is pending) needs a pure function the component calls with its latest-state snapshot (38.001: `rowSendOptions(latest.current, id)` in `bulkStart.ts`), so the test exercises the real code, not a copy.
- **Coverage targets name a `lib/` module.** Components rendered through `web/tests/renderHelper.mjs` are bundled into `node_modules/.cache/render-tests` and never appear in the coverage table, so "~100% of new code" is measurable only on the pure module (38.001: `bulkStart.ts`; the dialog is held by render and source checks). Word the criterion that way.

## Comments or actions anchored to lines of an agent draft (36.002 line comments)

Every later step had to decide these; state them in the task:
- **One word per state: hidden or disabled.** "Not offered when read-only" and "use the read-only title pattern" conflict, since that pattern keeps the control visible and disabled. For each state (read-only, finalized, no live session, no draft) say hidden, or disabled with which title. 36.002 settled on: read-only disabled with `READ_ONLY_TITLE`, finalized hidden, no session disabled with a reason.
- **What happens when the draft changes under the anchor.** Say what the daemon does when the line text no longer matches (36.002: 409 "The draft changed…"), what sent notes do on a new draft (clear), and where an unsent box goes (same line number, with a warning; a line past the end blocks Send).
- **The exact message and the limits.** Give the message typed to the agent, any context lines and their cut length, and every cap with its unit (36.002: comment 2,000 code points after trim; since 36.002.001 the line is cut to 240 UTF-8 bytes, each nearby line to 120, and nearby lines are dropped farthest first to keep the message within 500 bytes).
- **"Also on other tabs if it needs no extra work" needs a code check first.** Read how each named tab renders before writing it: the post tabs use `postResultFormat`, not `PLAIN_RESULT`, so 36.002's item 4 did not apply. Name the tabs in scope.

## Automatic starts after an upstream asset finalizes (37.003 Content Studio)

Planning left these open and Development decided them; state them in the task:
- **Existing UI base for a mockup element.** Grep the code for the mechanism a mockup element needs before approving it. 37.003's UI plan added a per-tab "Blocked" badge in the Concept tab strip, which has no badge mechanism, so it was not built. Either name it as new work with its own tests, or drop it from the mockup.
- **Retry of a kept refusal.** Say whether opening the tab retries a start the daemon was refused (37.003: no, the owner presses Start) and that Start is disabled when read-only.
- **Work started from inside a route that holds the Building's write queue.** Say that it must run after the response (a start from inside the finalize route would deadlock on `ctx.exclusive`) and what the owner sees in between ("starting").
- **Which posts get which asset.** Name the asset kinds per post format (image-set only for image and carousel posts) instead of leaving it to test planning.
- **Contract field names.** A new field on a published view (`blockedReason: string | null`, null when a session exists) is named in the task, not assumed by test planning.
- **New starts change other tests' counts.** A new start rule adds a session after the upstream finalize, so grep the tests that count terminal starts or sessions after that finalize and list them as to-update. 37.004's script → thumbnail start made `videoApi` I51 race once.

## A new asset modelled on an existing tab (37.004 Content Studio thumbnail)

The person had to settle these in Test Case Planning; state them in the task:
- **Package scope beats the title.** A task titled "(server)" whose items name a web view (the Publish dialog) or need web copies (the `contentRules.ts` mirror, labels, the footer job line) lists each web change as in or out. 37.004 left it to UI Planning to assume.
- **"Same as X" for every contract piece.** For a clone of the Images tab, say for each piece whether it reuses or copies X: storage table, job kind and footer text, finalize body and its 400 field, alt-text limits, archive path, style section, and wording ("X's messages with the noun swapped"). Otherwise each piece is a separate open question.
- **A shared asset's life.** Say what creates it (first matching post), whether later matching posts reuse it, what deleting the last matching post does (37.004: keep it), and what a migration does to existing records and to post statuses already finalized.
- **Read the writer before specifying a reader.** When a task reads another asset's `content` (Publish media, an agent prompt), name its current format from the code that writes it. 37.004 listed `postMedia.ts`, which reads the video's `content` as a path while Finalize has stored a render id since 37.002; neither planning nor tests caught it because the Publish tests set a path by hand.
- **Integration cases that need a long upstream flow.** When a case needs a real upstream finalize (the video's checklist and confirm flow), say whether a pure rule test plus an existing integration case is enough, or name the test helper to build.

## Agent-led data entry and read-only records (37.009 Imported Concepts)

- **Decide how the data gets in before writing a form.** For past, bulk or messy data, ask the owner in planning: form, or an agent session they hand raw material to. 37.009 specified a dialog and a POST route; the owner rejected the mockup and asked for an agent, which replaced item 6 and parts of items 2 and 7 and cost a full UI round.
- **What an agent-led entry task states.** The session's parent (none means its own record store, see [New session kinds](#new-session-kinds-and-user-named-records)), its exact tools, one record per call or a batch, refusals by field path (`posts[1].text`), how files arrive (paste and paths, or an upload control), and whether the save needs the owner's yes in chat. If that yes is instruction text only, say so and make it a manual check.
- **When a round replaces spec items, restate the task.** List which items are dropped or overridden, and the new routes, tools and session kinds, and correct the task's file and test lists. 37.009's text still described the dialog and route through Development, and every later step had to read around it.
- **"Works as today" is a claim to check.** Grep `web/src/ui` for the control, not only the server route. 37.009's "Deleting … works as today" assumed a web delete; only the route and an unused store action existed.
- **Every action named in copy has a reachable control.** Check each refusal message, hint and agent instruction that tells the owner to do something. "Delete and import again" was the only way to correct imported text, no mockup drew the control, and Code Review raised it as major.
- **A locked record lists every writing route, by route file.** Go through each `router.post/patch/put/delete` that takes the id, including ones the web cannot reach, and mark each refused or open with the reason. 37.009's table missed media upload, rename and delete in `videoRoutes.ts`.
- **Name the set from its source.** A rule for "tabs that start sessions" is taken from `CONCEPT_TABS` and `STUDIO_TABS`, not typed from memory. 37.009's item 7 named Script, Video and Images and left out Post content, Captions, Blog and Thumbnail.
- **Say what each new field belongs to, and what blank means.** Per post or per Concept (`externalAssets`), and for each optional field whether blank is none or a refusal (37.009: blank post text is none, a blank script is refused). Also state time defaults, the note limit and the status label of a record with no drafting stage. Test Case Planning had to ask about all of these.

## Settings with a source, guards on agent output, and tab-scoped UI (37.006 Script footer)

The person had to settle these in Test Case Planning, or Development found them; state them in the task:
- **A setting with a `source` needs its transitions.** Listing `source: 'default' | 'manual'` plus "anything outside the range is 400" left open: the GET versus PATCH shape (nested `speakingSpeed: { speakingWpm, source }` versus top-level `speakingWpm`), the storage key, whether saving the default value on purpose becomes `manual`, whether a form whose single Save sends every field marks an unchanged value `manual` (37.006: the web sends it only when it changed), and how to get back to `default`. Say each one; "no reset" is a valid answer but must be written, since `null` as a reset conflicts with a strict 400 rule.
- **A guard that refuses agent output gets an accept list too.** For every refuse pattern ("a leading `Here is` preface", "a label line ending in `:`"), give real text it must still accept, in the languages the Building writes (Hindi and Hinglish here). 37.006's literal preface rule would have refused the hook "Here's why your sales dropped."; the person narrowed it to a first line that names script, draft or version or ends in `:`. Name the false positives you accept (a short spoken lead-in ending in `:`, a line that is only an aside) and tell the agent's instructions how to avoid them. Also say how lines are numbered (trimmed text, `\r\n`), and whether the message reports the first problem or all of them.
- **"Only on tab X" names the field that decides it.** Check that field for every tab the shared pane serves. Post texts and articles are not in `concept.assets` (they hang off `posts[].needs`), and `StudioPane`'s `assetKind` lookup falls back to `script`, so "show only when the asset kind is script" would have shown Script stats on Post content, Captions and Blog. 37.006 added the no-fallback `isScriptAsset`.
- **Mockup padding on a shared component.** Read the component's own padding before a mockup sets one: `TaskTerminal` already pads its xterm 8px (`p-2`, as on the Tasks screen), so 37.006's planned 12/16px was dropped. Say "keep the component's padding" or name the change and the other views it touches (see [Restyling a shared component](#restyling-a-shared-component-in-one-view)).

## Moving a per-record setting or credential to an app-wide one (37.011 Google OAuth client)

Test Case Planning had to ask the person, or Development decided alone; state these in the task:
- **One rule for records whose value differs.** "Keeps working until reconnect" needs a per-record fallback read; "uses only the global value" does not. The 37.011 spec said both, and the person chose global-only: migration deleted **every** SEO Building's pair. Pick one and make the migration, refresh and docs lines agree.
- **Migration edge cases.** Source order and tie-break (37.011: `createdAt`, then id), what a partial record does (source or not, deleted or kept), whether non-matching types are touched, and that a re-run writes nothing.
- **Name the storage, and check "follow the existing pattern".** Read the pattern before citing it: GitHub accounts store no secrets, so there was no global secret store to follow. A shared secret now goes in `appSecrets()` ([blueprint](blueprint.md), "Secrets and tenancy").
- **Old keys on generic routes.** Say whether generic routes that take any key (`PUT /api/projects/:id/secrets/:key`) must refuse the removed names; 37.011 left them accepted and unread.
- **Opening another surface on a section.** Check where its open state lives first. Global Settings is now opened with `openSettings(section)` in the world store.
- **Vendor error codes per failure path.** Name the code the vendor returns (37.011 assumed Google's `unauthorized_client` for a token of another client) or mark it unverified and name who checks it with a real account ([external APIs](#heavy-data-benchmarks-and-external-apis-10006-seo-building)).
- **Grep proposed new names.** A planned type or symbol may already exist (`SettingsSection` did, so the global one became `GlobalSettingsSection`).
- **Route bodies.** Every new route's response body and status codes, and any length limit, per [Check before a task is final](#check-before-a-task-is-final).

## Bulk actions over board cards (37.010 Start pending tasks)

UI Planning, Test Case Planning and the person settled these because the task left them open. State them in the task:
- **Name the real column and which cards count.** The board has no "Pending" column: not-started cards sit in the Planning column, many nested under planning or Plan & bugs sessions that may be collapsed, and a separate "Pending only" view (opened from the yard's crate stack) exists. Say which headers get the control and the card test (37.010: `primary === 'start'`, collapsed groups included, sessions and reference cards out), per [UI scope](#ui-scope).
- **Header room.** Before adding a control to a column header, check it at the minimum column width (15rem). The Planning header already overflowed there, so 37.010 needed a compact variant (`@container`, icons only below 24rem) that touched the existing buttons; say whether that is in scope.
- **Rows the batch cannot send.** For each kind (no default workflow, parents not merged, parent lookup failed or still running), say whether it is listed, checkable, counted in "N of M" and covered by Select all, and what it shows.
- **Close while sending.** Say whether Close and Escape work while starts are being sent (37.010 blocks them until the batch settles) and that the dialog never closes on its own.
- **Per-row choices with a common default.** Say whether a row override equal to the common value stays an override, what happens when the overridden option becomes unavailable or is deleted, and whether Retry lets failed rows change it. For a switch (no "inherit" choice), name how a row goes back to following the common value (38.001: a "Same as all" button) and whether that button is hidden or disabled on a locked row. Give the ids, accessible names and override marker of new controls, or say they follow the existing picker's pattern, so test planning does not guess them.
- **Per-row values the daemon saves.** If a value sent with each start is stored on the task (`autoMerge` is saved on an accepted start), a default-on common switch overwrites every started task's saved setting. Say this is intended and that the spec documents it (38.001).
- **Result wording and numbers.** A row status that differs from the existing badge ("Queued (position N)" vs the card's "Waiting for a free slot · #N") is stated as intended ([Matching an existing control's wording](#matching-an-existing-controls-wording)); say whether N is the Project-wide place or the place in the batch, the fallback text for an empty refusal, and the button label (the mockup's "Start N tasks" replaced the task's "Start all").
- **Side effects of the reused single action.** Reusing `useTaskActions().start` per row also fires its queued notice (`queuedNoticeFor` in `web/src/lib/waitingList.ts`) once per queued row. Say whether the batch keeps or suppresses per-item notices.
- **Live board while open.** Say whether the run list is fixed when the batch starts and whether cards that appear while the dialog is open are listed checked or unchecked.

## Project deletion and rename (37.013 precedent)

- **Deleting a Project: list what it owns from the stores, not from the task.** Grep `server/src` for every `projectId`-keyed collection (tasks, task contexts, plan items, workflow and step runs, notifications, Agent sessions, saved commands, command runs) plus processes and terminals, and name each cleanup in the task. 37.013 listed only some of them; Code Review then found saved commands and command runs still leaking.
- **A removal needs its own `/ws` event.** `project` only upserts. When a task removes a record other views show, name the event (`projectDeleted` carries `projectId`) and say that the delete action and the event share one store reducer.
- **State the shape of a mixed request.** When a route gains a second field (PATCH `name` and `position`), say what happens with both, with one invalid, and with neither. Rule: validate everything first, change nothing on a 400.
- **Name the error body and limit unit** for new validation: `{ error, field }`, and "characters", not bytes.
