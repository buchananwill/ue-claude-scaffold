---
name: message-board-protocol
description: Use for any container agent that posts progress to the coordination server's message board. Defines the curl format, channels, message types, payload conventions, posting responsibilities, and verbosity levels.
---

# Message Board Protocol

The coordination server at `$SERVER_URL` provides a message board for reporting progress. The human operator reads `GET /messages/general` to reconstruct a timeline of your work. Always post at the prescribed moments — but never let a failed post interrupt your work.

## How to Post

Use curl via the Bash tool:

```bash
curl -s -X POST "${SERVER_URL}/messages" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Name: ${AGENT_NAME}" \
  -d '{"channel":"general","type":"phase_start","payload":{"phase":"1","title":"...","status":"starting","notes":"..."}}' \
  --max-time 5 >/dev/null 2>&1 || true
```

`SERVER_URL` and `AGENT_NAME` are environment variables already set in the container. The `|| true` makes the call non-fatal.

## Channels

- **`general`** — Phase transitions, failures, and final summaries. This is what the human reads.
- **`<role-name>`** (e.g. `implementer`, `reviewer`) — Sub-agent progress. Post build results, investigation notes, and detailed progress here.

## Message Types

| type             | when to use                                             |
|------------------|---------------------------------------------------------|
| `phase_start`    | Beginning a new phase                                   |
| `phase_complete` | Phase passed build and review                           |
| `phase_failed`   | Phase could not be completed after retries              |
| `build_result`   | After each build attempt                                |
| `status_update`  | Progress narration, decisions, notable observations     |
| `summary`        | Final post when all work is done or the run has stopped |

## Payload Conventions

Keep payloads concise — they are stored in SQLite. Include at minimum:

- **Phase events**: `{ "phase": "<id>", "title": "<title>", "status": "...", "notes": "..." }`
- **Build results**: `{ "phase": "<id>", "outcome": "pass" | "fail", "errors": ["..."] }`
- **Status updates**: `{ "message": "<your message>" }`
- **Summary**: `{ "summary": "<markdown block>" }`

## Who Posts

The **orchestrator** is the primary message poster. Sub-agents (implementer, reviewer, tester) do not post to the message board. The orchestrator reads their output and relays the relevant parts. This avoids fragile multi-hop messaging chains.

## Verbosity

Your delegation prompt may include a `LOG_VERBOSITY` level (`quiet`, `normal`, or `verbose`). If not specified, **default to `verbose`**.

**`quiet`** — Mandatory posts only.

**`normal`** — Mandatory posts, plus build outcomes with error summaries, and notable decisions or deviations from the plan.

**`verbose`** — Everything from `normal`, plus:
- Post a `status_update` when you start a significant block of work.
- Post after completing each significant chunk.
- Post when you encounter something unexpected or make a non-obvious decision.
- Post build results with enough detail to diagnose without reading the full log.

When in doubt about whether to post in verbose mode, post. The cost of a message is negligible; the cost of a silent 25-minute gap is an operator who can't tell if you're stuck or making progress.
