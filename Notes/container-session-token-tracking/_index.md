# Container Session Token Tracking

## Goal
Add a `claude_code_container_sessions` table that records every `claude -p` invocation fired from a container: token counts parsed from the session's stream-json output, and the raw result event stored as `jsonb` for recovery when parsing fails. Sessions are created at invocation start with status `running` and finalized at exit with status `complete`, `aborted`, or `stopped`. Sessions that are never finalized represent genuine aberrant terminations (OOM kill, container crash, network failure mid-PATCH) and remain `running` as orphaned records — so `running` is the unambiguous "we never saw this end" state.

Status semantics:
- `running` — open, not yet finalized (or genuinely orphaned).
- `complete` — Claude exited cleanly with exit code 0.
- `aborted` — abnormal exit detected by `_detect_abnormal_exit` (non-zero exit, hang, OOM tail, etc.).
- `stopped` — operator-initiated stop via `/tmp/.stop_requested`. Distinct from `aborted` so operators can filter "real failures" from "I pressed stop."

## Context
- Schema: [server/src/schema/tables.ts](../../server/src/schema/tables.ts). Migrations: [server/drizzle/](../../server/drizzle/) as numbered SQL files (current highest: `0005_add_agent_type_override.sql`).
- Every `claude -p` session in a container passes through `_run_claude` in [container/lib/run-claude.sh](../../container/lib/run-claude.sh). This is the only place to instrument.
- Switching `--output-format text` → `--output-format stream-json --verbose` makes Claude Code emit newline-delimited JSON events to stdout throughout the session. The `--verbose` flag is **mandatory** in `-p` mode when using `stream-json` — the CLI rejects the combination otherwise with `When using --print, --output-format=stream-json requires --verbose`. The final event (`"type":"result"`) carries `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`. This final event line is extracted for token parsing and stored as the `raw_output` jsonb column.
- The existing capture pipeline — `claude ... 2>&1 | tee "$CLAUDE_OUTPUT_LOG"` — is preserved unchanged. With `--verbose` + stream-json, `$CLAUDE_OUTPUT_LOG` and the host-mounted `/logs/${AGENT_NAME}-*.log` will contain dense NDJSON instead of human-readable prose; this is an accepted observability cost in exchange for cost tracking and full event-level forensics. Operators triaging a live container will need `jq` to filter, not plain `tail`.
- `_detect_abnormal_exit` sends the last 200 lines (capped at 50KB) to the AI exit-classifier at `/agents/{name}/exit-classify`; that endpoint will now receive NDJSON event lines rather than plain text. The classifier can still reason about NDJSON, but its prior heuristics were tuned on prose tails — expect to tune the classifier prompt during the rollout if false-positive or false-negative rates drift. Track this as a follow-up after Phase 3 lands.
- `$AGENT_ID` (UUID, registered agent identity) is always set in the container before `_run_claude` is called. `$CURRENT_TASK_ID` is a numeric string when a task is claimed, empty string otherwise.
- JSON payloads to the server must be built via `jq` into a tmpfile and `curl -d @tmpfile`. Never hand-build JSON in shell.
- Timestamp convention: every existing column in [tables.ts](../../server/src/schema/tables.ts) and every existing migration file uses `timestamp` (Postgres `timestamp without time zone`) — there are zero `timestamptz` columns in the schema. New tables MUST follow this convention to avoid a repeat of the prior Drizzle/SQL/UI disagreement bug. Postgres `timestamp without time zone` accepts ISO 8601 strings and silently strips the offset; this is safe only because the container, Supabase, and PGlite all run UTC.

## Phases

1. [Phase 1 — DB schema and migration](./phase-1-db-schema-and-migration.md)
2. [Phase 2 — Server sessions route](./phase-2-server-sessions-route.md)
3. [Phase 3 — Container output capture and session lifecycle](./phase-3-container-output-capture-and-session-lifecycle.md)
