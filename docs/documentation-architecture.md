# Documentation architecture: format decisions, and the Plan schema

**What this is**: a design proposal, not a decision record — written to react to and adjust, not something already built. It answers "how should this app's documentation be handled going forward," triggered by wanting a JSON-based, per-project Roadmap in place of a markdown one. No code was changed for this.

**Naming, settled during this design pass**: the new roadmap-item concept is called a **Plan**. That word was already taken — by the `'plan'` Task kind, the per-Project "Plan" (the five fixed docs: Specifications/Requirements/Test Cases/E2E Testing/Performance Testing, plus the Tasks breakdown, per `glossary.md`), and `plan.ts`/`PLAN_INSTRUCTIONS` in the code — so the decision made here is to **rename the existing concept to "Spec"** and free up "Plan" for this new one. Section 6 below is the full punch list of what that rename actually touches; it hasn't been done yet, and until it is, every existing doc/file that currently says "Plan" still means the *old* concept.

---

## 1. The real question: does JSON actually reduce "slop," and when

Worth being precise here before committing a format decision across every doc, because the honest answer is "it depends which problem you're solving," not "JSON always wins."

**The byte-level argument is actually a wash, sometimes worse.** A markdown table states each column name once, in the header; a JSON array of objects repeats every field name on every row (`"itemName":`, `"linkedOutcome":`, ... twelve times per item). For a genuinely tabular document with many rows and this many columns, a flat markdown table is often *more* token-compact than the equivalent JSON array, not less. So "JSON instead of markdown" isn't, by itself, the lever that cuts context bloat — treat that framing with some suspicion.

**The lever that actually matters is what JSON gets you architecturally, which markdown-as-a-file structurally can't:**

- **Stable identity per record.** This app already made exactly this call once, for exactly this reason: the Tasks breakdown (`PlanItemRecord`) is structured data in the central store, not a parsed markdown checklist, because — per `architecture.md`'s own words — "a checklist item needs a stable identity across edits — a status, a link to the real Task(s) run for it, a place to reorder it — and a fragile regex-based reconciliation between freeform agent-edited text and that identity was exactly the kind of complexity" worth avoiding. Every field in your Plan table (Status, Owner, Dependencies-by-reference, Priority) needs exactly this same stable identity. That's the real argument for JSON here — not compactness, but *being a real record the app can query, mutate a single field of, and reason about*, the same way it already does for Tasks.
- **Selective retrieval.** Once something is structured, the app can hand an agent (or you) *only the rows that matter right now* — "every Plan linked to this Milestone that isn't `complete`" — instead of the whole document. A monolithic markdown file has no such seam; you either give the whole thing or write fragile text-slicing logic. This is the actual fix for "unnecessary slop and context": not the file's syntax, but never showing an agent (or yourself) more of the document than the current task needs.
- **No narrative drift.** A markdown doc invites restating context in prose every time it's touched — which is where a lot of real "AI slop" comes from (an agent re-explaining what a field means instead of just setting it). A typed field with an enum value can't drift into a paragraph.

**Conclusion — a decision rule, not a blanket switch:**

| This kind of document... | ...should be | Why |
|---|---|---|
| A list of trackable records with status/ownership/priority (the Roadmap's Plans, the Tasks breakdown) | **Structured JSON**, centrally stored, API-backed | Needs stable identity, queryability, selective retrieval — exactly the precedent `PlanItemRecord` already set |
| A single running narrative meant to be read top-to-bottom (Blueprint, the five Spec docs — Specifications/Requirements/Test Cases/E2E/Performance, general Notes) | **Stays markdown** | There's no second row to give an identity to; forcing prose into a JSON envelope adds `{"content": "..."}` ceremony without gaining any of JSON's actual benefits, and loses git-diff readability and human skimmability for nothing |
| A list of discrete-but-narrative entries (Decision logs, and arguably Milestones' own metadata) | **Structured JSON with a markdown-formatted text field inside each record** | Gets stable identity (status: accepted/superseded, date, linked outcome) *and* keeps room for real prose where it's actually needed (the decision's rationale) — best of both, not a compromise |

So: yes to JSON for the Roadmap — it's the right call, and for the right reason (it's a table of records, not a report). The same reasoning extends naturally to Decision logs (currently unstructured markdown files per `.docs/decision-logs/`, despite the ADR shape recommended in the companion methodology doc being inherently record-like: title/status/context/decision/consequences). Blueprint and the Spec docs should stay markdown — they're narratives, and JSON-ifying them would be format-shopping without a real payoff.

---

## 2. Where the Roadmap sits in the existing hierarchy

This app already has three levels of "what to build": **Milestone** ("a target state for a Project with its own definition of done") → **Tasks breakdown / `PlanItemRecord`** (a runnable unit of work, optionally tagged to a Milestone) → **Task** (one real, executed agent run). Your table's fields — Linked outcome, Priority, Timing (Now/Next/Later), Owner, Effort estimate — describe something one level *above* Milestone: a strategic initiative that hasn't necessarily been broken into a target state yet, may be "Later" and speculative, and — critically — may not even be agent-executed work at all (an Owner who's a person, not a Worker).

Proposed hierarchy, adding one new concept (`Outcome`) alongside the renamed one (`Plan`):

```
Outcome (new, strategic, few, long-lived — "why we're doing anything")
   │
   ▼
Plan (new — an initiative supporting an Outcome; Now/Next/Later; may or may not be agent work)
   │
   ▼  (once it's actually ready to build)
Milestone (existing — a concrete target state, broken into...)
   │
   ▼
Tasks-breakdown item (existing — today's `PlanItemRecord`, proposed rename `SpecItemRecord` — a runnable unit)
   │
   ▼
Task (existing — one real, executed run)
```

`Linked outcome` in your table is the top arrow. I'd introduce a small, separate **Outcome** record rather than reusing Milestone for it — a Milestone is inherently a *build* target ("broken into Tasks-breakdown items"); an Outcome is a *reason* ("increase activation," "ship the v2 launch") that can outlive and span several Milestones, and several unrelated Plans can point at the same Outcome. Keeping them distinct avoids overloading Milestone with a second meaning it wasn't designed for.

A Plan doesn't have to become a Milestone — a "Could-have, Later" Plan can sit untouched for months, which is exactly the point of a roadmap as opposed to an active spec. When one *is* picked up, it's worth a loose, optional trace (a `promotedToMilestoneId` field) rather than a hard structural requirement, so the two stay linked without forcing every Plan through the same pipeline.

The Roadmap itself — the list/view of Plans — isn't a new idea for this app to absorb: `blueprint.md` already names "a roadmap" as one of the free-form files a Project's `.docs/` folder anticipates, alongside notes/decision-logs/tasks, just never detailed further. This design gives that already-planned-for file a real shape instead of leaving it as an unwritten placeholder.

---

## 3. Proposed schemas

Field types below are a proposal to react to, not a spec to build against verbatim — the goal is to get the shape right before worrying about exact TypeScript.

### `Outcome`

```json
{
  "id": "outcome-activation",
  "projectId": "proj_123",
  "name": "Improve first-week activation",
  "description": "New users aren't reaching their first real value moment fast enough.",
  "status": "active"
}
```
Deliberately minimal — a short, stable list per Project, edited rarely. `status`: `active | achieved | dropped`.

### `Plan` — your table, typed

```json
{
  "id": "plan_2026_09_17_001",
  "projectId": "proj_123",
  "itemName": "Ship guided onboarding checklist",
  "linkedOutcomeId": "outcome-activation",
  "description": "A first-run checklist surfacing the 3 actions correlated with week-1 retention. Matters because [...]",
  "deliverables": [
    { "type": "feature", "label": "Onboarding checklist component" },
    { "type": "content", "label": "Copy for the 3 checklist steps" }
  ],
  "acceptanceCriteria": [
    { "text": "New users see the checklist on first login", "met": false },
    { "text": "Completing all 3 steps is logged as an activation event", "met": false }
  ],
  "priority": { "level": "must", "reason": "Directly blocks the activation outcome this quarter" },
  "owner": { "type": "delegate", "personId": "person_jane" },
  "timing": { "mode": "bucket", "bucket": "next" },
  "effort": { "mode": "tshirt", "size": "medium" },
  "dependencies": [
    { "type": "plan", "id": "plan_2026_08_02_004", "note": "needs the new event-tracking pipeline first" },
    { "type": "external", "note": "waiting on final copy sign-off" }
  ],
  "status": "planned",
  "risks": [
    { "text": "Design hasn't been reviewed yet", "severity": "medium" }
  ],
  "elaboration": {
    "status": "drafted",
    "whatIsNeeded": "A 3-step checklist component surfaced on first login, plus an activation event fired on completion.",
    "whyNeeded": "Week-1 retention is the outcome this quarter is judged on, and the 3 actions in the checklist are the ones already correlated with a user staying past week 1.",
    "whoWillUseIt": "New signups in their first session — not existing users.",
    "problemSolved": "New users currently land on an empty dashboard with no signal of what to do first, so most never reach the actions that predict retention.",
    "elaboratedAt": "2026-09-17T11:30:00Z"
  },
  "createdAt": "2026-09-17T10:00:00Z",
  "updatedAt": "2026-09-17T10:00:00Z"
}
```

Notes on choices, each deliberately minimal rather than over-built (per the same YAGNI discipline your own global CLAUDE.md already asks for):

- **`priority`/`timing`/`effort` as tagged unions**, not bare strings — you asked for "Must/Should/Could, with a brief reason" and "Now/Next/Later, *or* a planned start/end date," so the schema should actually allow both modes rather than forcing every item onto one shape. Same for effort (T-shirt size *or* person-days).
- **`acceptanceCriteria` as objects with a `met` boolean**, not plain strings — lets a Plan show "3 of 5 criteria met" while still `in_progress`, which a flat string list can't express. Small addition, high value, doesn't complicate the schema.
- **`dependencies` distinguish an internal reference (another Plan, by id) from an external one** (free text — "waiting on a contract," "needs a decision from someone") — a dependency on a *decision* still needing to be made is exactly as real as one on another piece of work, and shouldn't be forced to pretend it's a Plan of its own.
- **`status` enum**: `planned | in_progress | blocked | complete` per your list, plus I'd add `dropped` — a roadmap, unlike a Tasks breakdown, is explicitly a place where things get deprioritized and killed outright rather than merely deferred; without it, a dead Plan either lingers as `planned` forever or gets silently deleted and loses its history.
- **`createdAt`/`updatedAt`** — not in your table, but close to load-bearing for a document you described as "running... completing old items and adding new ones": without them there's no way to answer "what's actually new since I last looked" or feed the usage-trend view proposed in the companion command-center doc. Flagging as a recommended addition, not assuming it's wanted.

### Elaboration — turning a one-line entry into something committable

A Plan can be created as just a title with a rough priority/timing bucket — that's the point of a roadmap, capturing an idea before it's been thought through. `elaboration` is the deeper brief that gets filled in later, before the Plan is trusted enough to promote into a Milestone, structured around the four questions you gave:

- **What is needed?** — the concrete thing to build, in enough detail to hand to someone (agent or person) as a starting brief.
- **Why is it needed?** — the justification, distinct from `linkedOutcomeId`: the outcome says *which* goal this serves, this says *why this specific piece of work* actually moves it.
- **Who will use it?** — the audience/persona, which nothing else in the schema currently captures at all.
- **What problem will they solve with it?** — the pain point that exists without this, which is what actually makes the Plan worth prioritizing over another one competing for the same Now/Next/Later slot.

`elaboration.status` (`pending | drafted | reviewed`) tracks this as its own small lifecycle, independent of the Plan's execution `status` — a Plan can be `planned` with `elaboration.status: "pending"` (a raw idea) or `elaboration.status: "reviewed"` (fully thought through, just not started yet). This is also a natural, small Spec-kind Task prompt (the renamed `'plan'` kind — see section 6): "elaborate this Plan by answering these four questions," mirroring how the existing planning-chat instructions already drive that restricted, doc-only Task kind — elaboration doesn't need a new Task kind, just a specifically-prompted one that writes back into one Plan's `elaboration` field via the mutation pattern in section 5.

### `Person` — for the "owner is someone else" case

```json
{
  "id": "person_jane",
  "name": "Jane",
  "context": "Freelance designer, engaged per-project",
  "contact": { "channel": "whatsapp", "value": "+91..." }
}
```

Deliberately not a user account — no auth, no login, just enough to attribute and reach someone. This is the smallest possible thing that makes `owner.personId` meaningful, consistent with this app staying "local, single-user, no hosting" for *itself* (per `architecture.md`) even while it now tracks work assigned to other people.

---

## 4. Delegated-owner tracking — the part that's genuinely new

An agent-owned Task has verifiable progress for free: a transcript, a diff, a test run, a commit. A person-owned Plan has **none of that** — its status is only ever as fresh as the last time someone told the app what it is. That asymmetry is the actual design problem "tracking of the other person" is pointing at, and it's worth naming explicitly rather than papering over it with a plain `owner` string:

- **Make the trust difference visible, not implicit.** A Plan owned by a delegate should read differently in the UI than one an agent is actively executing — e.g. an explicit "self-reported" indicator — the same "don't conflate two different situations behind one signal" principle already adopted for the crashed-worker-vs-out-of-sync-branch fix in the command-center doc.
- **Track staleness, not just current status.** `updatedAt` per Plan (above) is enough to compute "this delegated Plan hasn't moved in 9 days" without any new mechanism — surfaced the same way an out-of-sync branch or a failed Task already surfaces attention today.
- **Reuse the two-way channel already proposed, rather than building a second one.** The companion command-center doc's two-way notification bridge (outbound alert + inbound reply routed back into the app) generalizes directly here: a scheduled nudge ("what's the status of *Ship guided onboarding checklist*?") to `person.contact`, with a reply parsed back into a status/notes update on that specific Plan — the same infrastructure, a second use case. This also reuses the scheduling capability recommended in the agentic-development-methodology doc (Part A, automation) rather than needing a third new subsystem.
- **Don't try to make a human's work look like an agent Task.** No transcript, no worktree, no forced TDD gate — a delegate isn't running inside this app's execution model at all. The only things this app owns for a delegated Plan are: who it's assigned to, what "done" means (`acceptanceCriteria`), and when it was last confirmed to still be true.

---

## 5. How this reaches an agent's context without becoming slop

This is where the earlier format analysis pays off directly: **store structured, inject compact.** When a Task's prompt needs Roadmap context (a Spec-kind Task doing quarterly planning, say), the daemon should:

1. Filter server-side to the relevant slice (e.g. Plans linked to the current Outcome, or `status != 'complete'`) — never hand over the whole Roadmap.
2. Render that slice as a **compact markdown table** at prompt-construction time, not raw JSON — per the byte-level point in section 1, a table is the more token-efficient *representation* for genuinely tabular data, even though JSON is the right *storage* format. JSON-in, table-out.
3. Let the agent's structured output mutate specific Plans by id — the same pattern already proven for the Tasks breakdown (today's `planTasks` add/update/remove mutation object — proposed rename `specTasks`, see section 6 — applied once a Spec-kind Task settles `'done'`). A `planMutations` object of the same shape is a natural, precedented extension, not a new design.

This is the concrete answer to "avoid unnecessary slop and context": not "JSON instead of markdown" as a blanket rule, but *structured storage, filtered retrieval, compact rendering, surgical mutation* — four separate wins, only one of which ("structured storage") is actually about the file format at all.

---

## 6. The rename this naming decision actually requires

Calling the new concept "Plan" only stays unambiguous if the old concept genuinely stops being called that — a half-finished rename (new docs say "Plan," old docs and all the running code still say "Plan" too, just meaning something else) is a worse outcome than not renaming at all, and is exactly the kind of drift the companion command-center doc already flagged as this project's biggest documentation risk. This is real, scoped follow-up work — not done as part of this design pass — with a genuine cost gradient:

**Code identifiers (mechanical, low-risk rename):**
- `TaskRecord.kind`: `'plan'` → `'spec'` (`server/src/domain/types.ts`, every call site in `workerManager.ts`, API request bodies, tests)
- `server/src/projects/plan.ts` → `spec.ts`; `PLAN_INSTRUCTIONS`, `PLAN_DISALLOWED_TOOLS`, `PLAN_STATUS_SCHEMA`, `CLONE_BOOTSTRAP_PROMPT`'s references → `SPEC_`-prefixed equivalents
- `PlanDocKey`, the fixed doc-key list, `readPlanDoc` → `SpecDocKey`/`readSpecDoc`
- Frontend: `PlanDocPanel`, `RawPlanDocPanel`, `planByProject`, `loadPlan`, `PlanningTab`, `sendChatMessage`'s default `kind: 'plan'`, the "Skip planning" checkbox's naming

**Filesystem paths (mechanical, but touches every already-created Project's real, existing folder):**
- `.docs/plan/` → `.docs/spec/` for every Project created before the rename ships — needs an actual migration step (rename-on-read, or a one-time move), not just new code, or every existing Project silently loses its plan docs' discoverability

**Persisted data (the highest-cost part — a real migration, not a rename):**
- `PlanItemRecord`/`PlanItemQueueEntry` → `SpecItemRecord`/`SpecItemQueueEntry`, and their backing files `server/data/plan-items.json`/`plan-item-queue.json` → `spec-items.json`/`spec-item-queue.json`, plus the `/api/plan-items` route family → `/api/spec-items` — renaming a live collection file needs either a migration script or a read-compatibility shim, since existing installs already have real data under the old names

**Docs (must move in the same pass, or they actively mislead the next agent that reads them):**
- `glossary.md`'s "Plan" entry → "Spec"
- `architecture.md`'s "Project plan documents and the Tasks breakdown" and "Agent-driven planning: a restricted Task kind, not a separate agent" sections
- `blueprint.md`'s "Project plan" bullet under "What's implemented"
- `server/README.md`'s "Project plan & Tasks breakdown" section

Sequencing suggestion: do this as one deliberate, atomic piece of work — code, data migration, and docs together — rather than letting "Plan now means the new thing" ship in fresh conversation and design docs (like this one) while the actual running app still uses the old meaning everywhere. Fittingly, this rename is itself a good first real entry once the Roadmap/Plan system exists to track it in.

---

## 7. Applying the same lens to the rest of `.docs/`

Once the Roadmap proves this pattern, the same reasoning extends cleanly to **Decision logs** (`.docs/decision-logs/`, currently unstructured markdown despite being a natural fit for the ADR shape proposed in the methodology doc — title/status/context/decision/consequences as typed fields, with `context`/`decision`/`consequences` as markdown-formatted prose *inside* the record). I'd deliberately **not** extend it to the Blueprint or the five Spec docs — they're single continuous narratives with no second row to give an identity to, and turning them into JSON would add ceremony for no retrieval or identity benefit. Milestones sit in between: their *metadata* (status, dates, linked Outcome) would benefit from structure, while their actual "definition of done" narrative should stay as prose — likely inside a text field on a structured Milestone record, mirroring the Decision-log treatment, rather than a full rewrite of how Milestones work today.

---

## 8. Open questions worth deciding before building anything

- Does a Plan live at the **Project** level only, or does it make sense to have some at a level above any single Project (e.g. "ship the mobile bridge," which cuts across this tool itself rather than any one managed Project)? Nothing in the schema above assumes single-project scoping, but the current data model (`projectId` on everything) does.
- Should `dependencies` on another Plan be allowed to cross Projects, once the cross-project relationship model from the command-center doc exists? Not needed for a first version, but worth not accidentally designing out.
- Is a dropped/complete Plan ever deleted, or does it stay forever as history (the same "never delete, just filter" choice the Completed Tasks tab already makes)? I'd default to "never delete," consistent with that existing precedent.
