# LM Watchdog Plan Review

## Topic

Validation review of [notes/line-manager-watchdog.md](../notes/line-manager-watchdog.md) — a 13-phase plan introducing a per-project Opus watchdog ("Line Manager") that monitors engineer pump containers and intervenes via chat when slop or rationalisation is detected.

## Why a review now

The plan grew through five iteration passes that materially restructured it:

- An `lm_findings` table was proposed and then dropped (cursors + LM behavioural memory replace it).
- An `lm_interventions` table was proposed and then dropped (existing `chat_messages` + a new column on `lm_inspections` cover the audit trail).
- A dedicated per-project intervention room was proposed and then dropped (the existing `CHAT_ROOM` env var and registration flow already give engineer containers their channel).
- The test-failure trigger was reframed: the regression count delta fires the trigger unconditionally, and the LM (not pre-judged severity) decides finding outcome based on corroborating commit content and rationalisation language.
- The LM agent definition was split into PSDE skills (Protocol + Schema shared, Domain + Environment per project).
- Engineer-side intervention wiring was originally deferred and then folded back in as Phases 11–12 once the user clarified that active intervention is the principal value.

Iterative restructuring produces residue — prose that survives from earlier shapes but no longer fits the current design. The plan is now structurally sound but its size (13 phases, ~840 lines) and history of shape-changes make a finishing pass worthwhile before splitting or dispatching.

## Three review goals (in priority order)

### Goal 1 — Iteration residue

Find leftover prose, stale forward references, duplicated rationale, or dropped-but-still-mentioned mechanisms from earlier passes.

Most likely places to look:

- The Context section (rewritten three times)
- Phase 6 audit invocation prose (re-described intervention vs finding flow multiple times)
- Phase 7 PSDE skill descriptions (the PSDE split was added late)
- Phase 12 driver dispatch table (severity model was extended after initial draft)
- Phase 13 smoke test (re-numbered twice, with steps inserted at different points)

Specifically check that no dropped table (`lm_findings`, `lm_interventions`) is still referenced anywhere, and that no dropped room concept (`lm-intervention-${projectId}`) survives.

### Goal 2 — Internal consistency

Verify the phase chain holds end-to-end:

- Schema additions in Phase 1 are consumed by Phase 2 endpoints.
- Phase 4 driver cursors match Phase 5 trigger inputs.
- Phase 6 audit bundle shape matches what Phase 7 skills describe.
- Phase 12 driver dispatch matches Phase 7 schema constraints.
- Phase 13 smoke test exercises everything Phases 1–12 promised.

Schema coherence is a particular focus — please walk these specifically:

- `lm_email_log.messageId` is polymorphic (references `messages.id` for findings and `chat_messages.id` for interventions, with no FK constraint). Is the audit trail genuinely unambiguous via the FK chain back through `lm_inspections`, or is this a wart that warrants the suggested rename to `outbound_id`?
- `lm_inspections.produced_message_id` and `produced_chat_message_id` are stated as mutually exclusive on a given inspection. Is that constraint enforced anywhere, or is it a documentation-only invariant the driver could violate?
- `produced_chat_message_id` is added in Phase 1 and consumed by Phase 10. Trace it to confirm the migration order is right.

### Goal 3 — Unnecessary complexity / reuse vs reinvent

Hardest goal. The plan went through two rounds of removing tables that were over-eager. Walk every introduced entity (every new table, route, skill, env var, container service) and ask: does this overlap something the scaffold already provides? Concrete suspects to scrutinise:

- The `lm_email_log` table — is there an existing audit/log mechanism in the scaffold (server logs, message-board entries, dashboard event log) that the email outcomes could ride on instead of a dedicated table?
- The `lm-domain-ue` / `lm-domain-scaffold` skill split — do existing domain skills (`scaffold-server-patterns`, `ue-cpp-style`, `scaffold-environment`, `ue-engine-mount`) already cover what an LM auditor needs, with the LM-specific concerns small enough to live entirely in the audit-protocol skill?
- The `WATCHDOG_DEFAULT_CHANNEL` finding-output channel — is there a natural existing channel (`general` or similar) we should write to instead of introducing a new one?
- The driver's `idleSinceTs` shutdown logic — does `/coalesce/status` already provide enough state that we could simplify or eliminate the bookkeeping?
- The new `orchestrator-intervention-protocol` skill — could the existing `chat-etiquette` and `channel-isolation` skills cover this with a small extension, or is a new skill genuinely warranted given the orchestrator's specific protocol-extension point requirements?
- The Resend integration's gating logic — is there a simpler shape (e.g. fire-and-forget with no log table, relying on Resend's own dashboard for audit) that would work for the operator's needs?

For each suspect: do not just confirm whether overlap exists — recommend the concrete reuse path or, if the new entity is justified, the smallest version of it that does the job.

## Out of scope for this review

The plan's strategic direction is fixed. Specifically:

- The user is committed to the LM concept, the heartbeat-on-Opus model, the cursor-based one-shot triggering, and the intervention path via chat.
- The PSDE skill split as a structural choice is fixed (the user explicitly requested it).
- The two-tier pause/intervene severity model is fixed (the user explicitly contrasted halt-the-pump vs course-correct-via-information).

The review is a finishing pass, not a redesign. Do not propose architectural rewrites; propose targeted edits.

## Deliverable expected from the team

A consent / dissent vote on the plan with concrete change requests where dissenting. Specifically:

- For each issue surfaced, name the file path, the phase number (or section), and the specific text or design decision in question.
- For complexity / overlap findings, name the existing scaffold entity that should be reused and how.
- For consistency findings, name both ends of the inconsistency.
- For residue findings, quote the residue verbatim and identify which earlier design pass it belonged to.

Brevity is welcome. A short, sharp dissent with three concrete change requests is more useful than a long approval that misses the wart in Phase 9.
