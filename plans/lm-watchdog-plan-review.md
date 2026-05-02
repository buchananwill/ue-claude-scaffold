# LM Watchdog Plan Review — Deliverable

**Plan reviewed:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md) (13 phases, ~840 lines)

**Brief:** [`briefs/lm-watchdog-plan-review.md`](../briefs/lm-watchdog-plan-review.md)

**Team:** leader-1 (discussion leader), architect-1, data-1, domain-1, elegance-1, changeling-1.

**Vote:** **5 Consent / 0 Dissent — convergence achieved unanimously.**

The plan's strategic direction (heartbeat-on-Opus model, cursor-based one-shot triggering, driver-as-sole-side-effect-author, PSDE skill split, two-tier severity model) is sound and out of scope for this review. The change requests below are the targeted finishing-pass edits the plan needs before dispatch.

---

## Change requests

### Dispatch blockers (must land before dispatch)

#### 1. Add `stale_window` to `RecordInspectionRequest.triggerKind`

- **Where:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md), Phase 2, `RecordInspectionRequest` interface (around line 105).
- **Inconsistency:** Phase 1 schema comment lists `triggerKind` values as `'heartbeat' | 'matcher' | 'anomaly' | 'mention' | 'stale_window'`. Phase 4's `Trigger` union also includes `{ kind: 'stale_window'; sinceSeconds: number }`. Phase 2's `RecordInspectionRequest.triggerKind` union, however, is `'heartbeat' | 'matcher' | 'anomaly' | 'mention'` — `stale_window` is missing.
- **Fix:** Add `'stale_window'` to `RecordInspectionRequest.triggerKind`.

#### 2. Add `producedMessageId?: number` to `RecordInspectionRequest` (heartbeat-quiet linkage)

- **Where:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md), Phase 2, `RecordInspectionRequest` interface.
- **Inconsistency:** Phase 6 specifies that on heartbeat-with-`outcome='quiet'`, the driver posts via `POST /messages` directly (not `POST /lm/findings`), then records the inspection. Phase 13 step 3 then asserts `produced_message_id` IS set on the heartbeat-quiet inspection row. With Phase 2's `RecordInspectionRequest` as written there is no field for the driver to pass the heartbeat message's ID — so the inspection row's `produced_message_id` cannot be set.
- **Fix:** Add `producedMessageId?: number` to `RecordInspectionRequest`. The driver passes it in after `POST /messages` succeeds.

#### 3. Correct `LmWindowResponse.recentBuilds` and `recentTasks` against the actual schema

- **Where:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md), Phase 2, `LmWindowResponse` (around lines 82–101).
- **Inconsistency (`recentBuilds`):** The interface uses field names that don't match `build_history` (verified in [`server/src/queries/builds.ts`](../server/src/queries/builds.ts) and [`server/src/schema/tables.ts`](../server/src/schema/tables.ts)):
  - `kind` — actual column is `type` (string).
  - `success: boolean` — actual column is `success: integer` (0/1).
  - `exitCode` — not stored at all (see #6).
  - `branch` — not in schema; the table stores `agent` (text), not branch.
  - `finishedAt` — not stored; would be `startedAt + durationMs`.
- **Inconsistency (`recentTasks`):** Verified against [`server/src/routes/tasks-types.ts`](../server/src/routes/tasks-types.ts):
  - `phaseId` — does not exist in the `tasks` schema.
  - `agentName` — schema has `claimedByAgentId` (UUID); a JOIN is required.
  - `startedAt` / `finishedAt` — schema columns are `claimedAt` / `completedAt`.
  - `planPath` — schema column is `sourcePath`.
- **Fix:** Rewrite both interfaces to use the actual column names, or add explicit aliases in the route's response mapper. Without this, every downstream phase that consumes `getWindow()` (Phases 4, 5, 6) builds against a phantom interface.

#### 4. Resolve `lm_email_log.messageId` polymorphism via two-column split

- **Where:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md), Phase 9, `lm_email_log` schema (around lines 590–599); Phase 10 `POST /lm/interventions` flow step 5 (around line 695).
- **Inconsistency:** Phase 9 declares `messageId: integer('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' })` — a hard FK to `messages`. Phase 10 says the column is "type `integer` with no FK constraint" and writes `chat_messages.id` into it. PGlite enforces FKs; the Phase 9 migration as written would reject any intervention email row.
- **Fix (mandate, not the plan's hedged "outbound_id" rename):** Split the column into two nullable columns matching the existing `lm_inspections` pattern:
  ```ts
  boardMessageId: integer('board_message_id').references(() => messages.id),
  chatMessageId: integer('chat_message_id').references(() => chatMessages.id),
  ```
  Add `CHECK ((board_message_id IS NULL) != (chat_message_id IS NULL))` so exactly one is set. **Both FK columns must omit `onDelete`** (Drizzle default `restrict`), matching `lm_inspections` — the Phase 9 schema's `onDelete: 'cascade'` is wrong for audit data because deleting a finding message would silently erase the email trail. (Note: `lm_email_log` elimination — folding the fields into `lm_inspections` directly — was proposed by changeling-1 and discussed; the team's chosen resolution is the two-column refactor, which preserves the diagnostic value of skip-reason rows without polluting the inspection table.)

#### 5. Enforce `lm_inspections` mutual-exclusion invariant with a CHECK constraint

- **Where:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md), Phase 1, `lm_inspections` schema (around lines 47–53).
- **Inconsistency:** The plan states `produced_message_id` and `produced_chat_message_id` are "mutually exclusive on a given inspection" but no constraint is declared. The driver could violate the invariant silently.
- **Fix:** Add `CHECK (produced_message_id IS NULL OR produced_chat_message_id IS NULL)` to the Phase 1 migration. PGlite supports CHECK constraints (precedent: `tasks_status_check`, `rooms_type_check`, `chat_messages_author_type_check`).

#### 6. Add `testFailureCount` column to `build_history` and surface it in `recentBuilds`

- **Where:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md), Phase 1 (migration), Phase 2 (`recentBuilds`), Phase 5 (`test_failure_count_increased` anomaly).
- **Inconsistency:** Phase 5 specifies the `test_failure_count_increased` anomaly as `now.failures > prev.failures` — a numeric comparison. The current `build_history` schema (verified in [`server/src/routes/build.ts`](../server/src/routes/build.ts)) stores `success: integer` (0/1) and `output: text`, but **no failure count column**. The anomaly cannot be implemented as described.
- **Fix:** Add `testFailureCount: integer('test_failure_count')` (nullable; populated by the build/test endpoint when `type='test'`) to `build_history` in Phase 1's migration, and surface it as `testFailureCount: number | null` on `recentBuilds` in Phase 2. The Phase 5 anomaly description is then implementable without parsing build output. (changeling-1's note: this is a cascade — Phase 1 migration + Phase 2 type + Phase 5 description must land as a single atomic edit pass.)

#### 7. Resolve `recentDiffs` prose-vs-type ambiguity in favour of seed-branch diff

- **Where:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md), Phase 6, `AuditContext.recentDiffs` type comment (around line 442) vs. Phase 6 Work step 2 prose (around line 468).
- **Inconsistency:** The prose says "diff against the project's seed branch `docker/${PROJECT_ID}/current-root`" (cumulative-since-seed). The type comment says `git diff sinceSha..nowSha` where `sinceSha` is the per-branch cursor SHA (incremental-since-last-poll). Different diffs.
- **Fix:** The **prose is correct** — the LM judges scope by reading the full set of files the agent has touched since branching, not just what changed in the last poll cycle. The type comment is residue. Update the type so `sinceSha` is the seed-branch HEAD SHA (rename the field to `agentDiff` or `cumulativeDiff` for clarity). Update the type comment to read `git diff <seedHeadSha>..<nowSha>`.

### Residue (must clean up before dispatch)

#### 8. Drop "room messages" from Phase 2 verification

- **Where:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md), Phase 2, Verification, first bullet (around line 148).
- **Residue (verbatim):** "window aggregation respects `since` and **includes both room and board messages**".
- **Earlier-pass origin:** From a draft when chat-room content was an evidence surface for the LM. The current Phase 2 Work section explicitly says "Chat-room content is not surfaced — the LM does not match against `/rooms/*` traffic."
- **Fix:** Rewrite the bullet to "window aggregation respects `since` and includes board messages, tasks, and builds (chat-room content is not surfaced)."

#### 9. Reconcile the four-cursor list in Context with `DriverCursors` in Phase 4

- **Where:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md), Context section (line 20) vs. Phase 4 `DriverCursors` interface (around lines 244–249).
- **Residue (verbatim, Context):** "last seen board message ID, last seen commit SHA per agent branch, last seen build ID, **last seen task transition timestamp**".
- **Earlier-pass origin:** A pass where task transitions were a separate cursor; in the current shape Phase 5's `phase_too_fast` consults task transitions in the window directly, without a dedicated cursor.
- **Fix:** Either drop the fourth cursor from the Context list, or (if task-transition deduplication is wanted) add `lastTaskId: number` to `DriverCursors` and document the corresponding scan in Phase 5. Drop is the smaller change.

#### 10. Disambiguate Phase 12 verification on `note`/`pause`/`intervene` dispatch

- **Where:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md), Phase 12, Verification (around line 789).
- **Residue (verbatim):** "assert the driver calls `POST /lm/findings` for `note`/`pause`, `POST /lm/findings` + `POST /coalesce/pause` for `pause`, and `POST /lm/interventions` for `intervene`."
- **Earlier-pass origin:** The two-tier model was extended to three tiers after the initial draft; `pause` ends up listed in two assertion groups, making the test spec ambiguous.
- **Fix:** Rewrite to "assert the driver calls `POST /lm/findings` for `note`, `POST /lm/findings` + `POST /coalesce/pause` for `pause`, and `POST /lm/interventions` for `intervene`."

### Refinement (non-blocking)

#### 11. Cite explicit step names in `orchestrator-intervention-protocol` skill

- **Where:** [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md), Phase 11, [`skills/orchestrator-intervention-protocol/SKILL.md`](../skills/orchestrator-intervention-protocol/SKILL.md) draft (around line 720).
- **Issue:** The skill body lists poll points by step (e.g. "after `Step 1 — Implement & Build`") but does not explicitly name the source skill. An implementer following the skill would have to cross-reference [`skills/orchestrator-phase-protocol/SKILL.md`](../skills/orchestrator-phase-protocol/SKILL.md) to verify the step names match.
- **Fix:** Add a sentence at the top of the poll-points section stating that the step names are taken verbatim from [`skills/orchestrator-phase-protocol/SKILL.md`](../skills/orchestrator-phase-protocol/SKILL.md), with the explicit step list as it stands at time of writing.

---

## Goal 3 dispositions: complexity / reuse vs reinvent

Each suspect from the brief was walked against the actual scaffold codebase. Resolutions:

| Suspect | Disposition | Reasoning |
|---|---|---|
| `lm_email_log` table | **Justified, refactor to two-column** (item 4). | Resend's dashboard only shows successful sends; `lm_email_log` is the only place an operator can diagnose *why* an email was silenced (cooldown, daily-cap, no-address). The skip-reason rows (`ok=false`) are the principal value of the table. The plan's polymorphic `messageId` is the wart, not the table itself. |
| `lm-domain-{ue,scaffold}` skill split | **Justified.** | Existing `scaffold-server-patterns`, `ue-cpp-style`, `scaffold-environment` are written from the implementer's perspective (how to write correct code). LM-domain skills cover rationalisation language and scope-drift signals — genuinely new content the audit-protocol skill cannot absorb without project coupling. |
| `WATCHDOG_DEFAULT_CHANNEL` (`lm-findings`) | **Justified.** | The `general` channel is actively used by orchestrator phase-workflow messages. Routing LM findings there would pollute the phase audit trail. `lm-findings` is just a config default — no new schema, no new route. |
| Driver `idleSinceTs` | **Justified.** | `/coalesce/status` returns `canCoalesce: boolean` only — instantaneous state. There is no server-side "idle for N seconds" counter. The driver must track duration locally. `idleSinceTs` is the minimal correct approach. |
| `orchestrator-intervention-protocol` skill | **Justified.** | Existing `chat-etiquette` covers tool mechanics and posture; `channel-isolation` covers container isolation. Neither covers (a) poll timing tied to phase-protocol step boundaries, (b) `system`-typed message semantics, or (c) the "LM provides information, not instructions" non-compliance guarantee. Used at five orchestrator definitions — genuine reuse, not indirection. |
| Resend gating logic | **Justified as written** (with the schema fix in item 4). | The three-check sequence (API key → address → cooldown → daily cap) is the simplest shape that supports operator diagnosis of skipped emails. Resend's own dashboard cannot answer "why was no email sent for finding X". |

---

## Out-of-scope items (per the brief)

- Strategic direction: LM concept, heartbeat-on-Opus model, cursor-based one-shot triggering, intervention path via chat — all fixed.
- PSDE skill split as a structural choice — fixed.
- Two-tier pause/intervene severity model — fixed.

The team confirmed each of these is structurally sound and consistent with existing scaffold patterns. None of the change requests above touch them.

---

## Final dispositions

- **Vote:** 5 Consent / 0 Dissent.
- **Action:** Apply change requests 1–11 to [`Notes/line-manager-watchdog.md`](../Notes/line-manager-watchdog.md) before dispatching the plan for implementation. Items 1–6 are interdependent and should be treated as a single atomic edit pass; items 7–10 are independent residue cleanups; item 11 is non-blocking but recommended.
- **Recommendation:** Once amendments land, the plan is safe to split for dispatch (the 13 phases divide naturally at the schema/server / driver / agent-skill / engineer-side / smoke-test boundaries).

---

## Final statements (verbatim)

**data-1:** "The plan's schema is structurally sound and the two new tables (`lm_inspections`, `lm_email_log`) are genuinely warranted — the iteration residue was in the API type definitions, not the table design. The single most important fix is the Phase 2 `LmWindowResponse` field mismatch cluster: `recentBuilds` and `recentTasks` types must be corrected against the actual schema before dispatch, or every downstream phase will compile against a phantom interface. Get those right and the rest of the 11 changes are surgical edits."

**architect-1:** "The plan is structurally well-conceived — the heartbeat-on-Opus model, cursor-based dedup, driver-only side-effects, and PSDE skill decomposition are all sound. The change requests surfaced here are precisely the kind of precision gaps that accumulate across five iteration passes: each individual finding is small, but together they represent the difference between a plan that dispatches cleanly and one that blocks the implementer at Phase 2's type definitions and Phase 9's migration. The highest-value fixes are items #3/#6 (the `recentBuilds`/`testFailureCount` schema mismatches), which would have caused the most implementation friction. The `lm_email_log` two-column refactor is the right structural fix, and data-1's `onDelete` note is a genuine correctness improvement that the deliverable should carry."

**elegance-1:** "The plan's economy is good — the five iteration passes successfully eliminated over-eager tables and rooms, and what remains is justified. The one structural wart that survived was `lm_email_log` following a different polymorphism pattern than `lm_inspections` for the same concept. The two-column refactor mandated in item 4 resolves this and makes the schema say what it means. The `orchestrator-intervention-protocol` skill is correctly designed as a composable extension rather than inline text in 5 agent definitions — that's the right abstraction shape. No elegance concerns remain."

**domain-1:** "The domain-grounding work confirmed: `authorType='system'` is an existing, tested value in `chat_messages` (CHECK constraint in migration 0004); `POST /coalesce/pause` and `GET /coalesce/status` are at the exact lines the plan cites; all five orchestrator definitions in the Phase 11 update list exist in `dynamic-agents/` and all carry `orchestrator-phase-protocol`; `CHAT_ROOM` is on line 27 of `docker-compose.template.yml`; and the `buildHistory` schema has no exit code or failure count column, which is what made the `testFailureCount` addition a genuine blocking issue rather than a naming preference. The plan's structural decisions are sound and consistent with existing scaffold patterns. The 11 change requests are all targeted edits, not architecture changes."

**changeling-1:** "The six dispatch blockers (items 1–6) form an interdependent set — `testFailureCount` in particular has a cascade of three changes (Phase 1 migration, Phase 2 `recentBuilds` type, Phase 5 anomaly description) that must land together or the anomaly is still broken. Whoever writes the plan amendment should treat items 1–6 as a single atomic edit pass, not six independent PRs, to avoid half-states that look fixed but aren't. The review found what it needed to find. The two hardest bugs — the `lm_email_log` FK write failure (would have failed silently on first intervention email) and the `testFailureCount` gap (the most important anomaly, unimplementable as specified) — survived five internal iteration passes before this team caught them. That's the argument for why a finishing review pass is worth doing before dispatch."
