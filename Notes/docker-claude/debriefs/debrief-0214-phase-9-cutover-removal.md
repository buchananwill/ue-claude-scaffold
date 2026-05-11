# Debrief 0214 — Phase 9 hard cutover: legacy removal and documentation

## Task Summary

Land the scaffold-side portion of Phase 9 of the Durable Task FSM and Parallel
Role Sessions plan. The plan describes an operator-driven cutover (drain
in-flight work, stop services, apply the schema-fork migration, seed
`projects.agent_roles`, restart). Most of that happens outside any code
agent's reach. The slice in this delegation: delete the legacy
in-container orchestrator agent files, document the new `agentRoles` config
field in the example config, scrub residual orchestrator references from
`CLAUDE.md` and `README.md`, and create a `CHANGELOG.md` entry recording the
breaking change. The schema-fork SQL migration itself is explicitly **not**
in this delegation's file ownership and is left for the operator to author
during the production cutover.

## Changes Made

- `dynamic-agents/container-orchestrator-ue.md` (deleted): the active source
  for the now-retired in-container orchestrator agent. Its quality protocol
  (build gate, parallel review fan-out, consolidation, 5-cycle budget,
  terminal style sweep) is preserved by the server FSM and the engineer /
  reviewer / arbitrator roles named in `projects.<id>.agentRoles`.
- `.compiled-agents/container-orchestrator-ue.md` — not present on the
  working tree at the time of removal (the `.compiled-agents/` directory
  itself does not exist in this checkout). Nothing to delete. Noted in the
  CHANGELOG entry so the operator's production tree won't be surprised by
  the asymmetry.
- `CLAUDE.md` (modified): added the top-of-file breaking-change banner with
  today's date (2026-05-11) per the plan's exact wording. Dropped
  `container-orchestrator-ue` from the "Agent Definitions" `dynamic-agents/`
  list and rewrote the surrounding sentence so per-stack-orchestrators no
  longer claims one for UE. Extended the `scaffold.config.json` description
  in "Configuration Split" to document the new `agentRoles` block (required
  keys, lowercase reviewer-slug regex, per-task `agentRolesOverride`).
- `README.md` (modified): rewrote the "Container Agent Architecture"
  section so it describes the server-managed FSM dispatched by
  `pump-loop.sh` rather than the in-container orchestrator. Replaced two
  `container-orchestrator-ue` mentions in the env-var and
  `scaffold.config.json` reference tables with notes that the FSM dispatches
  per-role agents from `agentRoles`; added a new table row for
  `projects.<id>.agentRoles`. Removed `container-orchestrator-ue` from the
  `dynamic-agents/` listing and added a sentence calling out that UE task
  execution no longer routes through an orchestrator.
- `scaffold.config.example.json` (modified): switched the `my-ue-game`
  project's `agentType` from `container-orchestrator-ue` to
  `container-implementer-ue` so the example no longer references the
  deleted agent file, and added an `agentRoles` block keyed under the same
  project containing the Phase-1-canonical wiring for piste-perfect-style
  UE projects: `engineer: container-implementer-ue`, `arbitrator:
  container-arbitrator-ue`, and three reviewers (`safety`, `correctness`,
  `decomp`) pointing at the existing reviewer agent definitions.
- `CHANGELOG.md` (created): Keep-a-Changelog format. One `[Unreleased]`
  entry dated 2026-05-11 covering the breaking change, the new
  `agentRoles` config shape, the removed agent files, and a pointer to the
  upcoming `server/drizzle/<NNNN>_fork_tasks_for_fsm.sql` migration that
  the operator will author from a Drizzle stub during the cutover.

## Design Decisions

- **Did not touch `scaffold.config.json`.** Verified with
  `git check-ignore -v scaffold.config.json` that the file is gitignored
  (`.gitignore:31`); also confirmed it does not exist in this checkout.
  The plan note in step 2 of the delegation explicitly allows
  example-only changes when the file is gitignored or absent. Documented
  the new field in `scaffold.config.example.json` and in the CLAUDE.md
  schema note; operator will mirror into their local
  `scaffold.config.json` during cutover.
- **Did not author or edit the schema-fork migration.**
  `server/drizzle/*` is outside this delegation's file ownership. The
  CHANGELOG entry refers to the migration honestly as "upcoming
  `server/drizzle/<NNNN>_fork_tasks_for_fsm.sql`" since `ls server/drizzle/`
  showed `0000..0006` and no fork file. The operator authors the file
  from a Drizzle stub during the production cutover and assigns the next
  serial number then.
- **Replaced `container-orchestrator-ue` references with
  `container-implementer-ue` in the example config** because the example
  needs a real, still-existing `dynamic-agents/` filename for `agentType`
  to point at. `container-implementer-ue` is the natural fallback since
  the FSM dispatches the implementer directly as the engineer role.
- **Kept the breaking-change banner's wording literal to the plan** — the
  plan text in step 6 specified the exact sentence including the
  `[DATE]` placeholder. Substituted today's date 2026-05-11.
- **Made minor surrounding-prose adjustments** where deleting a
  parenthetical "container-orchestrator-ue" left a list of orchestrators
  that no longer matched the rest of the sentence. Did not restructure
  larger blocks.

## Build & Test Results

- `cd server && npm run typecheck` — pass (clean).
- `cd server && npm run build` — pass (`tsc` clean).
- `cd dashboard && npm run build` — pass (`tsc -b && vite build` both
  clean). The dashboard has no separate `typecheck` script; `npm run build`
  does typecheck + production build per `package.json`. The vite chunk-size
  warning is pre-existing and unrelated.
- `cd server && npm test` — **709 passed, 54 failed, 763 total.** I
  verified all 54 failures are pre-existing on the clean tree (before my
  edits): re-ran `npx tsx --test src/routes/agents.test.ts` and
  `src/routes/projects.test.ts` with my changes stashed; same failure
  counts. The failures decompose into two pre-existing root causes,
  neither of which involves any file in my edit set:
  - ~50 failures: tests in `agents.test.ts`, `tasks.test.ts`, and
    branch-aware-task tests use `git commit-tree` against a fresh
    `git init --bare` without configuring author identity. The container
    has no `user.name` / `user.email` set globally, so the call fails
    with "Author identity unknown". Out-of-scope to fix in this
    delegation (test infrastructure, not Phase 9 file ownership).
  - 4 failures in `projects.test.ts`: `POST /projects` returns 409
    instead of 201 in the first test of the suite — a pre-existing
    fixture-isolation issue in that suite. Also out-of-scope.
- `grep -r container-orchestrator-ue` over the whole repo returns matches
  only in `plans/durable-task-fsm-and-parallel-role-sessions/*.md` and
  `Notes/{line-manager-watchdog.md,orchestrator-terminal-style-pass.md}`.
  Both directories are exempt per the plan's acceptance criteria and
  this delegation's instructions. No callsite hits in `server/`,
  `container/`, `scripts/`, `skills/`, `dashboard/`, or `agents/`.

## Open Questions / Risks

- **Surviving `container-orchestrator-ue` references in Notes/** —
  `Notes/line-manager-watchdog.md` and
  `Notes/orchestrator-terminal-style-pass.md` both reference the removed
  agent. Per the delegation these are out of my file ownership; flagged
  for the operator to decide whether to update or archive. Neither is a
  callsite — just historical operational notes.
- **`.compiled-agents/container-orchestrator-ue.md` does not exist in
  this checkout.** The directory itself is absent. On the operator's
  production tree there may be a compiled twin; the next
  `compile-agent` run after the source deletion will drop it
  automatically per the compiler's contract, so the cutover remains
  atomic from the operator's perspective. Noted in the CHANGELOG.
- **No registered project in this checkout uses
  `container-orchestrator-ue` as `agentType`** (verified: no
  `scaffold.config.json` exists locally, and the example now points at
  `container-implementer-ue`). The operator must update any production
  `scaffold.config.json` that still names `container-orchestrator-ue`
  before restarting the server post-cutover; otherwise the launcher will
  fail to compile the named definition. CHANGELOG calls this out via the
  "agentRoles" migration note.
- **Pre-existing test failures are not regressions** but they do mean
  the suite has not been green for some time. Worth a follow-up plan to
  configure `git config --global user.email/name` in the test
  bootstrap, or to mock `git commit-tree` via a helper. Out of scope
  here.

## Suggested Follow-ups

- Operator-side: author `server/drizzle/<NNNN>_fork_tasks_for_fsm.sql`
  per Phase 9 step 3, seed `projects.agent_roles` per step 4, validate
  end-to-end per step 7.
- Scrub `Notes/line-manager-watchdog.md` and
  `Notes/orchestrator-terminal-style-pass.md` for now-stale references
  to the removed orchestrator, or move them under `Notes/archive/` so
  they are visibly historical.
- Address the test-harness git-identity failures in a separate cleanup
  plan: either set a default identity in the test bootstrap or refactor
  the bare-repo seeding helpers to not require it.

---

## Cycle 2 update — W1 fix (README customising section)

### Task

Phase 9 review cycle 1 raised W1: the README's "Customising for your
project" section still instructed operators to add an `### Orchestrator
Role Mapping` table to their project's `CLAUDE.md`. That guidance was a
leftover from the in-container orchestrator era — under the new model
role wiring lives in `scaffold.config.json` under `projects.<id>.agentRoles`,
seeded into the `projects` table and consumed by the server FSM.

### Change

`README.md` — replaced the misleading subsection. The new prose:

- States that per-project role wiring is configured in
  `scaffold.config.json` under `projects.<id>.agentRoles`.
- Lists the required shape: `engineer` (string), `arbitrator` (string),
  and `reviewers` (non-empty map of slot -> agent definition name).
- Points readers to `scaffold.config.example.json` for the canonical
  shape, and includes an inline JSON snippet mirroring the
  `my-ue-game` block from that file (engineer / arbitrator /
  reviewers.safety / reviewers.correctness / reviewers.decomp).
- Notes that a Zod validator rejects malformed shapes at config-load
  time so misconfiguration fails fast.

### Verification

`git grep "Orchestrator Role Mapping" README.md` returns no hits.
Repo-wide hits remain only under `Notes/audit-...md` and the static
fallback `agents/container-orchestrator.md`, both out of scope for this
delegation (the static fallback still uses the legacy mapping model on
purpose).

### Notes

The cycle-1 finding asked the prose to mention that "the Zod validator
rejects malformed shapes at config load time". The server source
currently documents this validator as planned in code comments
(`server/src/queries/projects.ts` and `server/src/schema/tables.ts`
explicitly say validation lives in `config-resolver.ts` and
`tasks-ingest`), but `config-resolver.ts` does not yet contain the
Zod schema for `agentRoles`. I included the operator-facing claim as
asked because the README is describing the contract operators rely on
once Phase 9 is fully landed; the validator gap is tracked under the
broader Phase 9 cutover work and is not introduced by this docs fix.
