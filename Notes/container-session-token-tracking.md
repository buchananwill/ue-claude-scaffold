# Container Session Token Tracking

## Goal
Add a `claude_code_container_sessions` table that records every `claude -p` invocation fired from a container: token counts parsed from the session's stream-json output, and the raw result event stored as `jsonb` for recovery when parsing fails. Sessions are created at invocation start with status `running` and finalized at exit with status `complete`, `aborted`, or `stopped`. Sessions that are never finalized represent genuine aberrant terminations (OOM kill, container crash, network failure mid-PATCH) and remain `running` as orphaned records — so `running` is the unambiguous "we never saw this end" state.

Status semantics:
- `running` — open, not yet finalized (or genuinely orphaned).
- `complete` — Claude exited cleanly with exit code 0.
- `aborted` — abnormal exit detected by `_detect_abnormal_exit` (non-zero exit, hang, OOM tail, etc.).
- `stopped` — operator-initiated stop via `/tmp/.stop_requested`. Distinct from `aborted` so operators can filter "real failures" from "I pressed stop."

## Context
- Schema: [server/src/schema/tables.ts](../server/src/schema/tables.ts). Migrations: [server/drizzle/](../server/drizzle/) as numbered SQL files (current highest: `0005_add_agent_type_override.sql`).
- Every `claude -p` session in a container passes through `_run_claude` in [container/lib/run-claude.sh](../container/lib/run-claude.sh). This is the only place to instrument.
- Switching `--output-format text` → `--output-format stream-json --verbose` makes Claude Code emit newline-delimited JSON events to stdout throughout the session. The `--verbose` flag is **mandatory** in `-p` mode when using `stream-json` — the CLI rejects the combination otherwise with `When using --print, --output-format=stream-json requires --verbose`. The final event (`"type":"result"`) carries `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`. This final event line is extracted for token parsing and stored as the `raw_output` jsonb column.
- The existing capture pipeline — `claude ... 2>&1 | tee "$CLAUDE_OUTPUT_LOG"` — is preserved unchanged. With `--verbose` + stream-json, `$CLAUDE_OUTPUT_LOG` and the host-mounted `/logs/${AGENT_NAME}-*.log` will contain dense NDJSON instead of human-readable prose; this is an accepted observability cost in exchange for cost tracking and full event-level forensics. Operators triaging a live container will need `jq` to filter, not plain `tail`.
- `_detect_abnormal_exit` sends the last 200 lines (capped at 50KB) to the AI exit-classifier at `/agents/{name}/exit-classify`; that endpoint will now receive NDJSON event lines rather than plain text. The classifier can still reason about NDJSON, but its prior heuristics were tuned on prose tails — expect to tune the classifier prompt during the rollout if false-positive or false-negative rates drift. Track this as a follow-up after Phase 3 lands.
- `$AGENT_ID` (UUID, registered agent identity) is always set in the container before `_run_claude` is called. `$CURRENT_TASK_ID` is a numeric string when a task is claimed, empty string otherwise.
- JSON payloads to the server must be built via `jq` into a tmpfile and `curl -d @tmpfile`. Never hand-build JSON in shell.
- Timestamp convention: every existing column in [tables.ts](../server/src/schema/tables.ts) and every existing migration file uses `timestamp` (Postgres `timestamp without time zone`) — there are zero `timestamptz` columns in the schema. New tables MUST follow this convention to avoid a repeat of the prior Drizzle/SQL/UI disagreement bug. Postgres `timestamp without time zone` accepts ISO 8601 strings and silently strips the offset; this is safe only because the container, Supabase, and PGlite all run UTC.

<!-- PHASE-BOUNDARY -->

## Phase 1 — DB schema and migration

**Outcome:** The `claude_code_container_sessions` table exists in the Drizzle schema and a corresponding SQL migration file is present. Running `npm run db:migrate` from `server/` applies the migration without error on a clean PGlite instance.

**Types / APIs:**

New Drizzle table definition in `server/src/schema/tables.ts` (append as table 16):

```typescript
export const claudeCodeContainerSessions = pgTable('claude_code_container_sessions', {
  id:                   uuid('id').primaryKey(),
  projectId:            text('project_id').notNull().references(() => projects.id),
  agentId:              uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' }),
  taskId:               integer('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  status:               text('status').notNull().default('running'),
  startedAt:            timestamp('started_at').notNull().defaultNow(),
  endedAt:              timestamp('ended_at'),
  exitCode:             integer('exit_code'),
  inputTokens:          integer('input_tokens'),
  outputTokens:         integer('output_tokens'),
  cacheReadTokens:      integer('cache_read_tokens'),
  cacheCreationTokens:  integer('cache_creation_tokens'),
  rawOutput:            jsonb('raw_output'),
}, (table) => [
  check('ccs_status_check', sql`${table.status} IN ('running','complete','aborted','stopped')`),
  index('idx_ccs_project').on(table.projectId),
  index('idx_ccs_agent').on(table.agentId),
  index('idx_ccs_task').on(table.taskId),
  index('idx_ccs_project_started').on(table.projectId, table.startedAt.desc()),
]);
```

`timestamp` (without timezone) matches the convention used by every other table in the schema. Do not pass `{ withTimezone: true }`.

**Work:**
- Add the table definition above to `server/src/schema/tables.ts` after table 15 (`teamMembers`).
- Create `server/drizzle/0006_add_container_sessions.sql`:

```sql
CREATE TABLE "claude_code_container_sessions" (
  "id"                    uuid PRIMARY KEY,
  "project_id"            text NOT NULL REFERENCES "projects"("id"),
  "agent_id"              uuid NOT NULL REFERENCES "agents"("id"),
  "task_id"               integer REFERENCES "tasks"("id") ON DELETE SET NULL,
  "status"                text NOT NULL DEFAULT 'running',
  "started_at"            timestamp NOT NULL DEFAULT now(),
  "ended_at"              timestamp,
  "exit_code"             integer,
  "input_tokens"          integer,
  "output_tokens"         integer,
  "cache_read_tokens"     integer,
  "cache_creation_tokens" integer,
  "raw_output"            jsonb,
  CONSTRAINT "ccs_status_check" CHECK ("status" IN ('running','complete','aborted','stopped'))
);
--> statement-breakpoint
CREATE INDEX "idx_ccs_project" ON "claude_code_container_sessions" ("project_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_agent" ON "claude_code_container_sessions" ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_task" ON "claude_code_container_sessions" ("task_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_project_started" ON "claude_code_container_sessions" ("project_id", "started_at" DESC);
```

`timestamp` (without time zone) is mandatory here — it matches every other timestamp column in the schema. Do not change to `timestamptz`.

**Verification:** `cd server && npm run db:migrate` completes without error (targets PGlite in-container; validates the SQL is correct). Run `npm test` — no existing tests should fail. **Operator post-merge step:** run `npm run db:migrate` with `SCAFFOLD_DATABASE_URL` set to apply the migration to Supabase.

<!-- PHASE-BOUNDARY -->

## Phase 2 — Server sessions route

**Outcome:** Three endpoints exist and respond correctly:
- `POST /sessions` — inserts a `running` record, returns `{ id: string }` (UUID).
- `PATCH /sessions/:id` — updates token counts, status, and raw output; returns the updated row.
- `GET /sessions` — returns an array of session records filtered by optional query params.

**Types / APIs:**

```typescript
// POST /sessions body
interface CreateSessionBody {
  agentId: string;       // UUID — must match a registered agent in this project
  taskId?: number | null;
}

// PATCH /sessions/:id body (all fields optional)
interface UpdateSessionBody {
  status?: 'complete' | 'aborted' | 'stopped';
  exitCode?: number;
  endedAt?: string;      // ISO 8601 UTC — stored as `timestamp` (without time zone)
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  rawOutput?: Record<string, unknown>; // stored as jsonb
}

// GET /sessions query params
interface SessionsQuery {
  agentId?: string;
  taskId?: string;       // numeric string, parsed to integer
  status?: string;
  limit?: string;        // default 100, max 500
}
```

**Work:**
- Create `server/src/routes/sessions.ts` exporting a `FastifyPluginAsync` as default. Follow the same plugin shape as `server/src/routes/builds.ts` or `server/src/routes/files.ts` for reference.
- `POST /sessions`: resolve project via `resolveProject`; validate `agentId` is a UUID belonging to the project; insert a row with `crypto.randomUUID()` as `id`, `status = 'running'`, `startedAt = new Date()`; return `201` with `{ id }`.
- `PATCH /sessions/:id`: look up session by `id` and `projectId`; return `404` if not found; apply only the fields present in the body; return `200` with the updated row. Do not allow a re-patch from `complete`/`aborted`/`stopped` back to `running`. When the body sets `status` to a terminal value (`complete`/`aborted`/`stopped`) and `endedAt` is not supplied, the server stamps `endedAt = new Date()` itself — container clocks are not trusted as the authoritative finalize time, and the helper in Phase 3 deliberately omits `endedAt` from its payload.
- `GET /sessions`: filter by `projectId` (always applied from header), plus optional `agentId`, `taskId`, `status`. Default `limit = 100`, max `500`. Return array ordered by `startedAt DESC`.
- Add `export { default as sessionsPlugin } from './sessions.js';` to `server/src/routes/index.ts`.
- Add `import { sessionsPlugin } from './routes/index.js';` and `await server.register(sessionsPlugin);` to `server/src/index.ts` after `agentDefinitionsPlugin`.

**Verification:** `cd server && npm run typecheck` passes. Write [server/src/routes/sessions.test.ts](../server/src/routes/sessions.test.ts) following the same `node:test` + Drizzle test-helper pattern as [server/src/routes/builds.test.ts](../server/src/routes/builds.test.ts) and [server/src/routes/files.test.ts](../server/src/routes/files.test.ts). Required test coverage:

1. `POST /sessions` inserts a `running` row with the supplied `agentId` and `taskId` (or null) and returns 201 + `{ id }` (UUID).
2. `POST /sessions` rejects an `agentId` that does not belong to the requesting `projectId` with 400 or 404.
3. `PATCH /sessions/:id` updates token counts, status, exitCode, endedAt, and rawOutput; returns 200 with the updated row.
4. `PATCH /sessions/:id` returns 404 when the session does not exist or belongs to a different project.
5. `PATCH /sessions/:id` rejects a regression from `complete`/`aborted`/`stopped` back to `running` (return 409 or 400).
6. `GET /sessions` returns rows ordered by `startedAt DESC`, filtered correctly by `agentId`, `taskId`, `status`, and the `X-Project-Id` header. Default `limit = 100`, max `500`.

Run `npx tsx --test src/routes/sessions.test.ts` — all six cases must pass.

<!-- PHASE-BOUNDARY -->

## Phase 3 — Container output capture and session lifecycle

**Outcome:** Every `_run_claude` invocation (task, direct, chat) opens a session record at start and closes it at exit with token counts and raw result event. The three exit branches are finalized as follows:

- Normal exit → `complete`
- Abnormal exit (detected by `_detect_abnormal_exit`) → `aborted`
- Operator stop (`/tmp/.stop_requested`) → `stopped`

Orphaned `running` records are produced only by genuine container crashes (OOM kill, network failure during the finalize PATCH, host reboot). Parse failures leave token columns null but still close the record with the correct status and whatever raw output was captured.

**Types / APIs:**

New variables in `container/lib/env.sh` (add alongside `CURRENT_TASK_*` group):
```bash
CURRENT_SESSION_ID=""   # UUID returned by POST /sessions; empty if POST failed
```

Changes to `_run_claude` in `container/lib/run-claude.sh`:

```bash
# 1. Output format change in CLAUDE_ARGS — TWO lines must change together.
#    --verbose is mandatory; the CLI rejects stream-json without it in -p mode.
--output-format stream-json
--verbose                     # NEW — required for stream-json under -p

# 2. Session open — insert before the claude launch block.
# 3. Session close — called before every `return` AND before the
#    operator-stop `exit 0` path. Three explicit finalize calls:
#      - normal exit       → _finalize_session "complete" "$EXIT_CODE"
#      - abnormal exit     → _finalize_session "aborted"  "$EXIT_CODE"
#      - operator stop     → _finalize_session "stopped"  "$EXIT_CODE"
#    Only genuine crashes (where the process dies before reaching any
#    finalize call) leave a `running` row.
```

Helper `_finalize_session <status> <exit_code>` (add to `run-claude.sh`):
```bash
_finalize_session() {
  local status="$1" exit_code="$2"
  [ -z "$CURRENT_SESSION_ID" ] && return
  # Extract result event (last line matching '"type":"result"')
  local result_event=""
  if [ -f "$CLAUDE_OUTPUT_LOG" ]; then
    result_event=$(grep '"type":"result"' "$CLAUDE_OUTPUT_LOG" 2>/dev/null | tail -1 || true)
  fi
  # Parse token fields; fall back to null on any failure
  local input_t output_t cache_read_t cache_create_t
  input_t=$(echo "$result_event"      | jq -r '.usage.input_tokens              // empty' 2>/dev/null) || true
  output_t=$(echo "$result_event"     | jq -r '.usage.output_tokens             // empty' 2>/dev/null) || true
  cache_read_t=$(echo "$result_event" | jq -r '.usage.cache_read_input_tokens   // empty' 2>/dev/null) || true
  cache_create_t=$(echo "$result_event"| jq -r '.usage.cache_creation_input_tokens // empty' 2>/dev/null) || true
  # Build PATCH payload in tmpfile
  local patch_tmp
  patch_tmp=$(mktemp)
  if ! jq -n \
      --arg  status        "$status" \
      --argjson exitCode   "${exit_code}" \
      --argjson inputTokens       "${input_t:-null}" \
      --argjson outputTokens      "${output_t:-null}" \
      --argjson cacheReadTokens   "${cache_read_t:-null}" \
      --argjson cacheCreationTokens "${cache_create_t:-null}" \
      --argjson rawOutput  "${result_event:-null}" \
      '{status:$status,exitCode:$exitCode,
        inputTokens:$inputTokens,outputTokens:$outputTokens,
        cacheReadTokens:$cacheReadTokens,cacheCreationTokens:$cacheCreationTokens,
        rawOutput:$rawOutput}' > "$patch_tmp" 2>/dev/null; then
    # Graceful fallback: minimal patch without token fields
    jq -n --arg status "$status" --argjson exitCode "${exit_code}" \
        '{status:$status,exitCode:$exitCode}' > "$patch_tmp" 2>/dev/null || true
  fi
  _curl_server -s -X PATCH "${SERVER_URL}/sessions/${CURRENT_SESSION_ID}" \
      -H "Content-Type: application/json" \
      -d @"$patch_tmp" \
      --max-time 10 >/dev/null 2>&1 || true
  rm -f "$patch_tmp"
  CURRENT_SESSION_ID=""
}
```

**Work:**
- In [container/lib/env.sh](../container/lib/env.sh), add `CURRENT_SESSION_ID=""` in the `CURRENT_TASK_*` variable block.
- In [container/lib/run-claude.sh](../container/lib/run-claude.sh), change `--output-format text` to `--output-format stream-json` in `CLAUDE_ARGS` AND add `--verbose` on the next line. Both flags are required; omitting `--verbose` makes the CLI fail at startup with `When using --print, --output-format=stream-json requires --verbose`.
- In `_run_claude`, immediately before the `set +e` / claude launch block, add the session open:

```bash
# Open session record
CURRENT_SESSION_ID=""
local task_id_json="null"
[ -n "${CURRENT_TASK_ID:-}" ] && task_id_json="$CURRENT_TASK_ID"
local sess_open_tmp
sess_open_tmp=$(mktemp)
jq -n \
    --arg agentId "$AGENT_ID" \
    --argjson taskId "$task_id_json" \
    '{"agentId":$agentId,"taskId":$taskId}' > "$sess_open_tmp" 2>/dev/null
local sess_resp
sess_resp=$(_curl_server -s -X POST "${SERVER_URL}/sessions" \
    -H "Content-Type: application/json" \
    -d @"$sess_open_tmp" \
    --max-time 5 2>/dev/null) || sess_resp=""
rm -f "$sess_open_tmp"
CURRENT_SESSION_ID=$(echo "$sess_resp" | jq -r '.id // empty' 2>/dev/null) || CURRENT_SESSION_ID=""
```

- Add `_finalize_session` as a new function above `_run_claude`.
- In the **stop-requested path** (inside `if [ -f /tmp/.stop_requested ]`), add `_finalize_session "stopped" "$EXIT_CODE"` immediately before `exit 0`. This was previously an "acceptable orphan" — it is not. Operator-initiated stops are intentional and the tokens were spent; finalizing as `stopped` keeps the `running` state reserved for genuine "we never saw this end" cases.
- In the **abnormal exit path** (inside `if _detect_abnormal_exit ...`), add `_finalize_session "aborted" "$EXIT_CODE"` immediately before `return 1`.
- In the **normal exit path** (bottom of `_run_claude`), add `_finalize_session "complete" "$EXIT_CODE"` immediately before `return $EXIT_CODE`.
- Add `_reset_task_vars` to also clear `CURRENT_SESSION_ID=""` by expanding the function in [container/lib/env.sh](../container/lib/env.sh).

**Verification:**
- **Operator post-merge step:** rebuild the container image (`docker compose -f container/docker-compose.yml build`) and run a smoke test before reporting Phase 3 done. Orchestrators inside containers cannot recurse Docker, so the operator must run this step manually.
- Run the container in worker mode against a single queued task. After completion, `curl http://localhost:9100/sessions?agentId=<uuid>` returns one record with `status=complete`, non-null `inputTokens`, and a populated `rawOutput` object.
- Run `./stop.sh --agent <name>` mid-session. The session row finalizes with `status=stopped` and a populated `endedAt`.
- Kill a container mid-session with `docker kill <id>`. The session row remains `status=running` — confirms genuine-crash orphan behavior.
- Point `SERVER_URL` to a dead host (e.g. `SERVER_URL=http://127.0.0.1:1` via the launcher) and run a one-shot direct prompt. Session open POST fails silently; session runs to completion; no crash; `CURRENT_SESSION_ID` is empty; finalize call is a no-op.
- Confirm `/logs/${AGENT_NAME}-*.log` now contains NDJSON instead of prose (expected; observability cost accepted). Confirm `_detect_abnormal_exit` still fires correctly on a deliberately-failed task; if false-positive or false-negative rate drifts, raise a follow-up to tune the classifier prompt at [server/src/routes/exit-classify.ts](../server/src/routes/exit-classify.ts).
