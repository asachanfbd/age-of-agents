# Document shapes

Replace bracketed fields with evidence, or say 'not configured', 'not implemented', or 'unverified' precisely. These are shapes, not files to copy verbatim. Do not leave empty headings or invented example commands.

## AGENTS.md

```markdown
# [Project] operating contract
[One sentence identifying the project.]

Read `.docs/index.md`, `.docs/constraints.md`, the supplied task acceptance criteria,
and applicable scoped instructions before changing code. Load only relevant topic docs.
Inspect the implementation and existing tests before selecting a design.
Use commands from `.docs/development.md` and verification from `.docs/testing.md`.
Respect delegated decision boundaries; ask only for material unresolved decisions.
Never change requirements or weaken tests to make a task appear complete.
Report acceptance evidence, actual command outcomes, and documentation impact.
Task history and test results belong in Context Village; `.docs` holds current knowledge.
```

## index.md

```markdown
# Project context
## Read by task
| Task type | Read | Source paths |
| --- | --- | --- |
[Only real docs and source paths.]
## Authoritative sources
[Project-specific contracts, schemas, configuration, tokens, and test locations.]
## Maintenance
Keep current facts, constraints and active rationale. Update the owning topic;
do not append task reports. Split only when routing benefits. Test logs and tasks
live in Context Village. Generated reference names its source and generator.
```

## product.md

Purpose/users; domain vocabulary; implemented capabilities and observable behavior;
accepted current requirements/invariants; current gaps/limitations explicitly labeled.
No future feature backlog. For a blank project: state no implementation exists,
retain only supplied purpose and accepted constraints, and keep proposed designs in tasks.

## architecture.md

Actual stack (link manifests); boundaries/ownership; critical flows and interfaces;
data/transaction/trust boundaries; deployed topology if evidenced; current design
rationale with trade-offs/revisit conditions. No inventory of every file.

## development.md

Prerequisites; commands table (purpose, exact command, working directory, prerequisites);
configuration source and safe example file; local patterns/error/dependency conventions;
non-obvious environment limitations. Verification outcomes belong in the receipt.

## testing.md

Behavior-to-test-layer policy; exact command and fixture/setup references; isolation and
cleanup; regression expectations; completion checks; current coverage/tooling gaps.
Reference actual test paths. No fabricated coverage percentages or stored run results.

## constraints.md

| Scope | Requirement | Reason/authority | Verification/source |
| --- | --- | --- | --- |
[Only current, evidenced cross-cutting constraints.]

Record only standing project policy, not the permissions of this individual documentation run.
State which decisions are delegated and which materially change explicit product,
security, data, cost or integration commitments. Do not require approval for every
architecture/doc edit. No secrets, speculative bans, or rule weakening by retro.
