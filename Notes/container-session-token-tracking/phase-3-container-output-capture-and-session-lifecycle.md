# Phase 3 — Container output capture and session lifecycle

Part of [Container Session Token Tracking](./_index.md). See the index for the shared goal and context — this phase body assumes them.

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
- In [container/lib/env.sh](../../container/lib/env.sh), add `CURRENT_SESSION_ID=""` in the `CURRENT_TASK_*` variable block.
- In [container/lib/run-claude.sh](../../container/lib/run-claude.sh), change `--output-format text` to `--output-format stream-json` in `CLAUDE_ARGS` AND add `--verbose` on the next line. Both flags are required; omitting `--verbose` makes the CLI fail at startup with `When using --print, --output-format=stream-json requires --verbose`.
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
- Add `_reset_task_vars` to also clear `CURRENT_SESSION_ID=""` by expanding the function in [container/lib/env.sh](../../container/lib/env.sh).

**Verification:**
- **Operator post-merge step:** rebuild the container image (`docker compose -f container/docker-compose.yml build`) and run a smoke test before reporting Phase 3 done. Orchestrators inside containers cannot recurse Docker, so the operator must run this step manually.
- Run the container in worker mode against a single queued task. After completion, `curl http://localhost:9100/sessions?agentId=<uuid>` returns one record with `status=complete`, non-null `inputTokens`, and a populated `rawOutput` object.
- Run `./stop.sh --agent <name>` mid-session. The session row finalizes with `status=stopped` and a populated `endedAt`.
- Kill a container mid-session with `docker kill <id>`. The session row remains `status=running` — confirms genuine-crash orphan behavior.
- Point `SERVER_URL` to a dead host (e.g. `SERVER_URL=http://127.0.0.1:1` via the launcher) and run a one-shot direct prompt. Session open POST fails silently; session runs to completion; no crash; `CURRENT_SESSION_ID` is empty; finalize call is a no-op.
- Confirm `/logs/${AGENT_NAME}-*.log` now contains NDJSON instead of prose (expected; observability cost accepted). Confirm `_detect_abnormal_exit` still fires correctly on a deliberately-failed task; if false-positive or false-negative rate drifts, raise a follow-up to tune the classifier prompt at [server/src/routes/exit-classify.ts](../../server/src/routes/exit-classify.ts).
