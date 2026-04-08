# Phase 14: Operator rebuild and smoke test

Operator-run verification. The orchestrator cannot rebuild Docker from inside a container; this phase is manual action items for the operator to execute in sequence. It is the authoritative check that the plan's stated goal — two same-named agents in different projects cannot stomp each other's data — actually holds in a running system.

## Files

- `container/` (docker compose rebuild)
- Local PGlite data directory (backup + post-migration state)
- Live running containers and server (no tracked file changes)

## Work

1. `cd container && docker compose build` on the agent image. Confirm the build succeeds and produces a fresh image containing the updated `container/lib/registration.sh` with the session-token DELETE change from Phase 11.
2. Stop any existing containers: `./stop.sh` from the repo root. Confirm `docker ps` shows no `claude-*` containers.
3. Snapshot the local PGlite data directory one more time: `cp -r <pglite-data-dir> <pglite-data-dir>.backup-pre-schema-hardening-smoke-$(date +%Y%m%d-%H%M%S)`. If Phase 4's migration was already run earlier and you're smoke-testing on a post-migration DB, this captures the post-migration baseline. If Phase 4 has not yet been applied to this DB, this is your pre-migration backup.
4. Restart the coordination server: `cd server && npm run dev`. The migration runs at startup (or is already applied from Phase 4). Watch the console output for the three migration files (`0002_add_columns.sql`, `0003_backfill_and_orphans.sql`, `0004_constraints_and_swap.sql`) and confirm each applies cleanly or is already applied. If any fails, stop, restore the backup directory, investigate, and fix.
5. Query the DB post-migration and assert:
   - `agents.id` is populated for every row (no NULLs).
   - `tasks.claimed_by` column does not exist; `tasks.claimed_by_agent_id` exists and is a valid FK.
   - `room_members.member` column does not exist.
   - `chat_messages.sender` column does not exist; `chat_messages.author_type` and `chat_messages.author_agent_id` exist.
   - `messages.agent` still exists (historical audit) alongside `messages.agent_id`.
   - Row counts pre- vs. post-migration: live-state tables may have shrunk due to orphan cleanup; historical tables (`messages`, `build_history`, `chat_messages`) are identical in row count.
6. Chat protocol smoke test (single container):
   - `./launch.sh --project <some-id> --agent-name smoke-agent --fresh`. Wait for the container to register.
   - Confirm the agent's direct room exists: `curl http://localhost:9100/rooms?member=smoke-agent -H 'X-Project-Id: <some-id>'`. Expect exactly one room returned (the `smoke-agent-direct` room).
   - From the container, wait for the agent to call `reply` via the MCP `chat-channel` server (the default agent prompt should exercise this, or you can drive it explicitly via a direct prompt that instructs the agent to post a test message).
   - From the dashboard or via curl, POST a message to the room with no `X-Agent-Name` header (simulating the operator): `curl -X POST http://localhost:9100/rooms/smoke-agent-direct/messages -H 'Content-Type: application/json' -H 'X-Project-Id: <some-id>' -d '{"content":"hello from operator"}'`. Expect 200.
   - GET the room messages: `curl http://localhost:9100/rooms/smoke-agent-direct/messages -H 'X-Project-Id: <some-id>'`. Expect two messages: the agent's with `sender: 'smoke-agent'`, the operator's with `sender: 'user'`.
   - Call the agent's `check_messages` tool (either via a direct prompt to the container or by inspecting the container logs after the MCP poll cycle) and confirm the operator's message was visible.
7. Cross-project isolation smoke test (two containers, same agent name, different projects):
   - `./launch.sh --project <id-A> --agent-name agent-1 --fresh` in project A.
   - `./launch.sh --project <id-B> --agent-name agent-1 --fresh` in project B (intentionally reusing the name).
   - Verify both containers register successfully. `curl http://localhost:9100/agents/agent-1 -H 'X-Project-Id: <id-A>'` and same with `<id-B>` — assert each returns a row with a distinct `id` (UUID) and the matching `projectId`.
   - Give each container a task to work on (ingest via `scripts/ingest-tasks.sh` per project or create via the tasks API). Verify they can both claim and complete tasks without interference.
   - Let container A's queue drain and leave it pump-idle. It will time out after ~30 minutes with "No claimable tasks found after 60 attempts" and call `_shutdown`.
   - Confirm after container A's shutdown:
     - Container A's agent row has `status = 'deleted'` (not removed).
     - Container B's agent row is untouched (`status != 'deleted'`).
     - Container B's active task (if any) is still `in_progress` — its `claimed_by_agent_id` is unchanged.
     - Container B continues polling for new tasks and completes them normally.
8. Reactivation smoke test:
   - Re-launch `agent-1` in project A with `--fresh`.
   - Assert the agent row's `id` is unchanged from the pre-reactivation UUID (same UUID across the lifecycle).
   - Assert `status` is back to `'idle'`.
   - Assert `sessionToken` is rotated (different from the previous value).
9. Session-token mismatch smoke test (belt-and-braces layer):
   - With `agent-1` in project A running, manually send `curl -X DELETE 'http://localhost:9100/agents/agent-1?sessionToken=00000000000000000000000000000000' -H 'X-Project-Id: <id-A>'`.
   - Assert the server returns `409 Conflict`.
   - Assert the agent row is still present with unchanged status.
   - Assert the container is still running and functional.
10. Cleanup: `./stop.sh`. Confirm all containers are down. Leave the backup data directory in place until the operator is confident no rollback is needed.

## Acceptance criteria

- `docker compose build` succeeded and the new image contains the updated `container/lib/registration.sh`.
- Two containers with the same agent name in different projects coexist without interference for the full test duration.
- Container A's idle-timeout shutdown does not affect container B's active work in project B.
- Container A's agent row is soft-deleted (`status = 'deleted'`) rather than removed.
- Reactivation reuses the same `id` and rotates `sessionToken`.
- Session-token mismatch DELETE returns 409 and does not affect the agent row.
- Chat protocol round-trip (agent message, operator message, agent reads back the operator message) succeeds end-to-end.
- DB post-migration state matches the expected schema (columns present/absent, FKs enforced, historical audit columns preserved).
- No data loss beyond the orphan policy.
