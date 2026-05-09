# Plan: Durable Task FSM and Parallel Role Sessions

Lifts the in-container orchestrator's review-cycle state machine into Supabase, replaces the orchestrator agent with a deterministic shell daisy-chain, and runs each role (engineer, reviewers) as a top-level `claude -p` invocation rather than a sub-agent of an in-container orchestrator. Outcomes: every role gets full Agent tool depth (so engineers can dispatch Haiku helpers for cheap searches before duplicating shared code); review findings become structured queryable rows in Supabase rather than markdown blobs in git; container OAuth expiries and abnormal shutdowns no longer lose review cycle state because the FSM lives on the server.

The orchestrator agent (`.compiled-agents/container-orchestrator-ue.md`) is retired by this plan. Its quality protocol — build gate, parallel review fan-out, consolidation, 5-cycle budget, terminal style sweep — is preserved in full, but expressed as durable state transitions on the `tasks` table plus a thin shell loop, instead of an in-process Opus agent. The reviewer and engineer agent definitions themselves are unchanged in spirit; their invocation harness changes.

The debrief protocol is **not** touched in this plan. Migrating debriefs into Supabase and retiring `Notes/docker-claude/debriefs/` is deferred to a follow-up plan after this engine has run for a few weeks.

## Phases

1. [Phase 1 — Schema migration: task FSM columns and review tables](./phase-1-schema-migration-task-fsm-columns-and-review-tables.md)
2. [Phase 2 — Server FSM transition endpoint](./phase-2-server-fsm-transition-endpoint.md)
3. [Phase 3 — Server review ingestion, per-task fetch, and cross-task aggregation endpoints](./phase-3-server-review-ingestion-per-task-fetch-and-cross-task-aggregation-endpoints.md)
4. [Phase 4 — Container daisy-chain entrypoint](./phase-4-container-daisy-chain-entrypoint.md)
5. [Phase 5 — Engineer top-level session dispatch](./phase-5-engineer-top-level-session-dispatch.md)
6. [Phase 6 — Parallel reviewer dispatch and mechanical consolidation](./phase-6-parallel-reviewer-dispatch-and-mechanical-consolidation.md)
7. [Phase 7 — Arbitrator agent and dispatch](./phase-7-arbitrator-agent-and-dispatch.md)
8. [Phase 8 — Dashboard rendering of FSM and review tables](./phase-8-dashboard-rendering-of-fsm-and-review-tables.md)
9. [Phase 9 — Hard cutover, legacy removal, and documentation](./phase-9-hard-cutover-legacy-removal-and-documentation.md)
