# Phase 11: Container shutdown session token

Update `container/lib/registration.sh` so its `_shutdown` path sends the session token as a query parameter on its DELETE. This closes the belt-and-braces layer: even if scoping is ever broken again, a stale DELETE from one container cannot tear down another container's row.

No changes to `container/mcp-servers/chat-channel.mjs` — the agent's view of the chat HTTP contract is preserved end-to-end by the server-side rewrites in Phases 7 and 9. Verified on 2026-04-08 via trace of the full protocol (room discovery, polling, check_messages, reply, check_presence).

## Files

- `container/lib/registration.sh` (modify)

## Work

1. Confirm that `_register_agent` already captures `SESSION_TOKEN` from the registration response and exports it. The current code at `container/lib/registration.sh:164` does: `SESSION_TOKEN=$(echo "$REG_BODY" | jq -r '.sessionToken // empty'); export SESSION_TOKEN`. Leave this in place.
2. In `_shutdown` (currently at `container/lib/registration.sh:95`), find the DELETE call to `${SERVER_URL}/agents/${AGENT_NAME}`. Rewrite to append `?sessionToken=${SESSION_TOKEN}` to the URL, guarded by a format check on the token:
   ```bash
   local delete_url="${SERVER_URL}/agents/${AGENT_NAME}"
   if [[ "${SESSION_TOKEN:-}" =~ ^[0-9a-f]{32}$ ]]; then
       delete_url="${delete_url}?sessionToken=${SESSION_TOKEN}"
   fi
   _curl_server -s -X DELETE "$delete_url" \
       --max-time 5 >/dev/null 2>&1 || true
   ```
   The server generates tokens as 32 hex chars via `randomBytes(16).toString('hex')` in `server/src/routes/agents.ts:50`, so no URL encoding is needed, and rejecting malformed values prevents injection. The regex is anchored (`^...$`) to reject anything else.
3. Handle the 409 response path. The server now returns `409 Conflict` if the token does not match — meaning another container has taken over this agent slot. For the shutting-down container this is not an error: it means its work is done from the system's perspective. The existing `|| true` already swallows the non-200, which is sufficient. The container should log a one-line note if the DELETE got a 409 so the operator can see it in the logs; capture the HTTP status via `-w "%{http_code}"` and log a warning if it is 409, otherwise continue silently.
4. Do NOT change `_post_status` or any other endpoint caller. The `POST /agents/:name/status` endpoint in Phase 8 will now reject the value `'deleted'` from clients, but no container code currently sends that value — `_post_status "error"`, `_post_status "done"`, `_post_status "idle"`, `_post_status "working"` are the only call sites and all are valid.
5. Do NOT touch `container/mcp-servers/chat-channel.mjs`. The server-side rewrites in Phases 7 and 9 preserve the HTTP contract exactly: `GET /rooms?member=<name>` still works (handler resolves name → id internally), `GET /rooms/{id}/messages?since=<id>` still returns rows with a `sender` field (computed via COALESCE join), and `POST /rooms/{id}/messages` still accepts the same body shape. The MCP server is forward-compatible without changes.
6. Validate container shell syntax: `bash -n container/lib/registration.sh`. Fix any errors.
7. Commit. Message: `Phase 11: Container session-token check on DELETE, confirm chat-channel.mjs unchanged`.

## Acceptance criteria

- `container/lib/registration.sh` `_shutdown` function appends `?sessionToken=${SESSION_TOKEN}` to the DELETE URL when the token matches `^[0-9a-f]{32}$`.
- A 409 response from the server is logged but does not fail the shutdown sequence.
- `bash -n container/lib/registration.sh` exits 0.
- `container/mcp-servers/chat-channel.mjs` is unchanged (verify with `git diff`).
- Commit exists.
