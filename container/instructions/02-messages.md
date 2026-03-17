# Standing Instruction: Message Board

## Purpose

The coordination server at `$SERVER_URL` provides a message board for reporting progress. The human operator reads
`GET /messages/general` to reconstruct a timeline of your work. Always post to the message board at the prescribed
moments — but never let a failed post interrupt your work.

## How to post

Use curl via the Bash tool:

```bash
curl -s -X POST "${SERVER_URL}/messages" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Name: ${AGENT_NAME}" \
  -d '{"channel":"general","type":"phase_start","payload":{"phase":"1","title":"Data Model","status":"starting","notes":"..."}}' \
  --max-time 5 >/dev/null 2>&1 || true
```

`SERVER_URL` and `AGENT_NAME` are environment variables already set in the container. The `|| true` makes the call
non-fatal.

## Channels

- **`general`** — Phase transitions, failures, and final summaries. This is what the human reads. Keep it to the
  essentials.
- **`<role-name>`** (e.g. `implementer`, `reviewer`) — Verbose progress from sub-agents. Post build results and detailed
  notes here.

## Message types

| type             | when to use                                             |
|------------------|---------------------------------------------------------|
| `phase_start`    | Beginning a new phase                                   |
| `phase_complete` | Phase passed build and review                           |
| `phase_failed`   | Phase could not be completed after retries              |
| `build_result`   | After each build attempt                                |
| `summary`        | Final post when all work is done or the run has stopped |

## Payload conventions

Keep payloads concise — they are stored in SQLite. Include at minimum:

- **Phase events**: `{ "phase": "<id>", "title": "<title>", "status": "...", "notes": "..." }`
- **Build results**: `{ "phase": "<id>", "outcome": "pass" | "fail", "errors": ["..."] }`
- **Summary**: `{ "summary": "<markdown block>" }`

## When you must post

If you are the **orchestrator**: post `phase_start` and `phase_complete`/`phase_failed` for every phase, and `summary`
at the end.

If you are an **implementer**: post `build_result` after each build attempt to the `implementer` channel.

If you are a **reviewer**: no mandatory posts (your findings are returned to the orchestrator).
