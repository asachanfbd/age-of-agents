# Documentation blueprint

## Small core

Start with root `AGENTS.md` plus these six `.docs` files. These are chosen defaults for Context Village, not an industry standard or a promise of model reliability.

| File | Owns | Read when |
| --- | --- | --- |
| `.docs/index.md` | Routing table, canonical source pointers, documentation maintenance rules | Starting a task |
| `.docs/product.md` | Purpose, domain terms, implemented capabilities, current behavior, accepted product constraints, current limitations | Changing behavior |
| `.docs/architecture.md` | Actual stack, component boundaries, ownership, key flows, integrations, deployment topology, current decision rationale | Changing affected boundaries |
| `.docs/development.md` | Environment prerequisites, exact setup/dev/build commands, config references, local coding/error/dependency conventions | Implementing or running locally |
| `.docs/testing.md` | Acceptance verification, test layers, exact commands, fixtures, isolation, regression policy, current verification gaps | Implementing or verifying changes |
| `.docs/constraints.md` | Cross-cutting invariants, delegated decision boundaries, current security/performance requirements and verification links | Planning any change |

Root `AGENTS.md` contains: a short project identity; read `.docs/index.md`, `.docs/constraints.md`, task brief and scoped instructions; route by task; inspect code; implement and test against acceptance criteria; report evidence and documentation impact. Reference the command home rather than duplicating command tables. No separate AI_INDEX.md. Keep vendor adapters minimal and preserve existing effective instructions.

Task definitions, roadmap, proposed designs, questions, transcripts, completion records, test results and retro receipts belong in Context Village's task store. Have the runner supply the relevant task packet. Do not create CURRENT_FEATURE.md, task folders, incident histories, dated ADR series, or changelogs inside `.docs`.

## Grow by demonstrated need

Split a topic when it has independent readers, repeated routing needs, or becomes difficult to retrieve. Keep core files as short summaries and links after splitting. Create no empty directory trees.

| Optional path | Trigger and content |
| --- | --- |
| `.docs/domains/<domain>.md` | Substantial domain behavior, terms, invariants and cross-domain contracts |
| `.docs/components/<component>.md` | Complex subsystem ownership, interfaces, flows, failure handling and current rationale |
| `.docs/security.md` | Substantial auth, trust, redaction and threat constraints |
| `.docs/performance.md` | Explicit budgets with workload, dataset, environment and measurement method; observed baselines labeled separately |
| `.docs/design.md` | UI behavior/accessibility constraints and links to actual tokens and reusable components |
| `.docs/operations.md` | Real deployment, rollback, migrations, backups, monitoring and recovery commands |
| `.docs/generated/` | Useful generated reference with an actual source, generator and freshness check |

Keep at most one directory level below `.docs` by default. A documented need may justify more. Initial soft budgets: root AGENTS ≤80 lines, index ≤100, each core topic ≤180, optional topic ≤200. Aim for roughly 2,000 tokens of always-loaded project context (AGENTS + index + constraints); measure using available tooling or label an estimate. Do not delete important constraints to satisfy a numeric budget. Trim duplication, narrow routing, then split. Total knowledge may grow; default task loading must stay selective.

## Sources of truth

| Question | Evidence |
| --- | --- |
| What should happen? | Explicit accepted requirements and constraints; tests express these but may be incomplete/wrong |
| What currently exists? | Code, manifests, configuration, infrastructure definitions at the target snapshot |
| What ran successfully? | Captured test/tool results tied to revision and environment |
| Why this design? | Explicit decision evidence; otherwise mark rationale unknown |
| What is the interface/schema? | The project's canonical machine-readable contract or implementation, with ownership clearly named |
| What work is next? | Context Village tasks, not `.docs` |

For code-first contracts, derive reference from code; for contract-first projects, preserve the specification as authoring source and verify implementation conformance. Generated output can be incomplete or stale. It is not guaranteed correct merely because a generator produced it. Generate/verify alongside the relevant change, not exclusively after merge.

Record active decision rationale in the relevant architecture/component section: decision, scope, reason, current trade-off, revisit condition, source/control pointer. Replace obsolete decisions; recover history from Git/task records. Do not append dated narratives.

Record current limitations as current facts with affected scope. Distinguish a bug from desired behavior. Keep a material unresolved conflict visible as unverified rather than choosing whichever source is convenient.
