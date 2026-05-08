# Debrief 0190 — Phase 3: container session lifecycle

## Task Summary

Implement Phase 3 of the container session token tracking plan
([phase-3-container-output-capture-and-session-lifecycle.md](../../container-session-token-tracking/phase-3-container-output-capture-and-session-lifecycle.md)):
have every `_run_claude` invocation in the container open a `claude_code_container_sessions`
record at start, switch Claude's stdout to NDJSON (`stream-json` + `--verbose`) so the final
`result` event with `usage.*` token counts is captured to the existing log, and finalize the
session on each of the three exit branches with the correct status — `complete`, `aborted`,
or `stopped`. Failures of the open POST or finalize PATCH must be silent and non-fatal.

Phases 1 (DB schema) and 2 (server `/sessions` route) are already merged.

## Changes Made

- `container/lib/env.sh` — added `CURRENT_SESSION_ID=""` declaration in the `CURRENT_*` task
  variable block, and extended `_reset_task_vars` to clear it. The session ID lives alongside
  the per-task variables because every `_run_claude` invocation is conceptually one session,
  whether or not a task is claimed.
- `container/lib/run-claude.sh`:
  - In the `CLAUDE_ARGS` array, switched `--output-format text` → `--output-format stream-json`
    and added `--verbose` on the next line (the CLI rejects stream-json under `-p` without it).
    The existing capture pipeline (`claude ... 2>&1 | tee "$CLAUDE_OUTPUT_LOG"`) is preserved;
    `$CLAUDE_OUTPUT_LOG` and `/logs/${AGENT_NAME}-*.log` will now contain dense NDJSON instead
    of prose — accepted observability cost called out in the plan/index.
  - Added a new `_finalize_session <status> <exit_code>` helper above `_run_claude`. It is a
    no-op when `CURRENT_SESSION_ID` is empty; otherwise it greps the last `"type":"result"`
    line out of `$CLAUDE_OUTPUT_LOG`, parses the four token fields with `jq` (each falling back
    to `null` on parse failure), builds the PATCH body in a tmpfile, sends it to
    `/sessions/${CURRENT_SESSION_ID}` with `--max-time 10`, and unconditionally swallows
    failures (`>/dev/null 2>&1 || true`). If the full jq build fails it falls back to a minimal
    `{status, exitCode}` payload so we still close the row.
  - Inside `_run_claude`, immediately before `set +e`, added the session-open block: build
    `{agentId, taskId}` via jq into a tmpfile, POST to `/sessions` with `--max-time 5`, parse
    `.id` out of the response into `CURRENT_SESSION_ID`. Any failure leaves `CURRENT_SESSION_ID`
    empty so the later finalize call becomes a no-op.
  - Wired the three exit branches:
    - Stop-requested path: `_finalize_session "stopped" "$EXIT_CODE"` immediately before
      `exit 0`.
    - Abnormal-exit path: `_finalize_session "aborted" "$EXIT_CODE"` immediately before
      `return 1`.
    - Normal-exit path: `_finalize_session "complete" "$EXIT_CODE"` immediately before
      `return $EXIT_CODE`.
- `Notes/docker-claude/debriefs/debrief-0190-phase3-container-session-lifecycle.md` — this file.

## Design Decisions

- **`set -euo pipefail` not added.** The other container/lib files do not use strict mode, and
  the plan explicitly scopes this work to the env.sh and run-claude.sh edits above. Tightening
  shell-strict mode for the whole library is out of scope; flagging here as a follow-up.
- **`grep '"type":"result"'` for the result-event capture.** Plan-specified. NDJSON guarantees
  the result event is on a single line, so a simple line grep + `tail -1` is correct and
  cheaper than streaming-jq across the entire log.
- **`--argjson rawOutput "${result_event:-null}"`.** When `result_event` is empty we substitute
  the literal string `null` so jq parses it as the JSON null. When the result event is present
  it is itself a single line of valid JSON, so feeding it via `--argjson` parses it as a JSON
  object — which is exactly the `jsonb` shape the server's `rawOutput` column expects.
- **Numeric task ID without quotes via `--argjson taskId`.** `CURRENT_TASK_ID` is a numeric
  string from the task queue; `--argjson` lets jq parse it as a JSON number. When unset we
  default the local variable to `"null"`, which jq reads as the JSON `null` literal — matching
  the server's nullable `taskId` field. Safer than building the JSON by hand.
- **Session ID cleared on `_reset_task_vars`** even though `_run_claude` already clears it on
  entry. Pump-loop call sites that reset between iterations should not be left with a stale
  ID; cheap belt-and-braces given the helper exists.
- **Failure silence.** Per the plan, both the open POST and the finalize PATCH redirect their
  output to `/dev/null` and short-circuit with `|| true`. The agent's primary work must never
  break because the sessions endpoint is unreachable. `CURRENT_SESSION_ID=""` after the
  finalize PATCH guards against accidental double-finalize if a later code path were ever to
  call the helper again on the same session.

## Build & Test Results

Per the plan, container image rebuild and runtime smoke tests are an **operator post-merge
step**: orchestrators inside containers cannot recurse Docker (`docker compose build` /
`./launch.sh` are not available in here), and the plan explicitly defers the verification
checklist to the operator.

Build gate inside the container is the syntactic validation of both shell files:

- `bash -n /workspace/container/lib/env.sh` → clean (no output, exit 0; "env.sh OK" echoed)
- `bash -n /workspace/container/lib/run-claude.sh` → clean (no output, exit 0; "run-claude.sh OK" echoed)

The deferred operator checklist (rebuild image, run worker against a queued task, exercise
`./stop.sh`, `docker kill`, dead-`SERVER_URL` paths) is captured verbatim in the plan body
under "Verification" and is not re-listed here.

## Open Questions / Risks

- **Classifier prompt drift.** `_detect_abnormal_exit` sends the last 200 lines of
  `$CLAUDE_OUTPUT_LOG` (capped at 50KB) to the AI exit-classifier at
  `/agents/{name}/exit-classify`. With this change those lines are NDJSON event records
  rather than prose. The plan flags this and the index calls it an expected tuning follow-up
  — not a Phase 3 deliverable. Watch false-positive / false-negative rates on the first few
  rollout days; if they drift, raise an issue against
  `server/src/routes/exit-classify.ts`.
- **`jq` availability.** All other call sites in the container assume `jq` is on PATH (e.g. the
  task complete/fail payloads in the same file already use it), so this introduces no new
  dependency. If `jq` were ever missing, the open block would silently leave
  `CURRENT_SESSION_ID` empty and the whole feature degrades to a no-op rather than crashing
  the agent.
- **Empty `AGENT_ID`.** The index states `$AGENT_ID` is always set before `_run_claude`. If
  registration ever fails to populate it, the POST body will carry `agentId: ""` and the
  server will reject it. The failure surfaces as silent skip (empty `CURRENT_SESSION_ID`),
  which is the plan's intended behaviour for "session endpoint unreachable / unhappy."
- **Log readability.** Container `/logs/${AGENT_NAME}-*.log` files now contain NDJSON. Triage
  workflows that relied on `tail -f` for human-readable progress will need `jq` filtering. Plan
  acknowledges this trade-off.

## Suggested Follow-ups

- Add a small `jq` filter recipe to the operator runbook (`Notes/operational-runbook.md`) for
  triaging NDJSON logs, e.g.
  `jq -rR 'fromjson? | select(.type=="assistant") | .message.content[0].text // empty'`
  to reconstruct the prose stream from a session log.
- Tune the exit-classifier prompt in `server/src/routes/exit-classify.ts` for NDJSON tails
  once we have post-rollout data on misclassification.
- Consider tightening `set -euo pipefail` across `container/lib/*.sh` as a separate
  hygiene pass — out of scope here but the library is large enough now to benefit.

## Cycle 1 fixes

Safety review raised two findings on the Phase 3 commit (878b6cc); both addressed in this cycle.

### [B1] BLOCKING — session-open `jq -n` lacks `|| true` guard

**File:** `container/lib/run-claude.sh` (~line 210)

The script runs under `set -euo pipefail` (entrypoint.sh line 2). The local `set +e`
that brackets the `claude` invocation does not apply to the session-open `jq -n` call
nine lines earlier. If `jq` exits non-zero before the `set +e`, the entire script
aborts before claude ever launches — silently dropping the task and violating the
"sessions instrumentation must never break primary work" contract.

Appended `|| true` to the `jq -n ... > "$sess_open_tmp"` invocation so a failure
cannot abort the script. `sess_open_tmp` is still cleaned up at the existing
`rm -f` line, and `CURRENT_SESSION_ID` will end up empty (because `sess_resp` is
empty / not valid JSON), short-circuiting `_finalize_session` to its no-op branch.

### [W1] WARNING — `CURRENT_SESSION_ID` lacked UUID-shape validation

**File:** `container/lib/run-claude.sh` (~lines 218-222)

`CURRENT_SESSION_ID` was interpolated into the `_curl_server` PATCH URL without
shape validation. The server currently always returns a `randomUUID()` value, but
defence-in-depth requires UUID validation before embedding into a URL — analogous
to the server-side `UUID_RE.test(id)` guard in `server/src/routes/sessions.ts:149`
and to `pump-loop.sh`'s allowlist-regex check on `CURRENT_TASK_ID`.

Added a UUID regex check immediately after the `jq -r '.id // empty'` extraction
that blanks `CURRENT_SESSION_ID` if it does not match the canonical UUID shape
(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`). A malformed,
missing, or path-traversal value short-circuits `_finalize_session` to its no-op
branch, keeping with the non-fatal philosophy.

### Build verification

- `bash -n container/lib/run-claude.sh` — PASS.
- No `env.sh` changes; only `run-claude.sh` was touched.
