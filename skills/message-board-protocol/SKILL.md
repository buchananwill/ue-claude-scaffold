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

## Smoke Test — First Message

Your very first action, before reading the plan or doing any work, is to post a hello message to the `general` channel:

```bash
curl -sf -X POST "${SERVER_URL}/messages" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Name: ${AGENT_NAME}" \
  -d '{"channel":"general","type":"status_update","payload":{"message":"Agent online. Beginning work."}}' \
  --max-time 5
```

This confirms you can reach the message board and that you are visible to the operator. If this post fails, stop immediately and report the error as your final output — a broken message board means the operator has no visibility into your work.

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

You are the primary message poster. Your sub-agents do not post to the message board — you read their output and relay the relevant parts. This avoids fragile multi-hop messaging chains.

## Verbosity

Your delegation prompt may include a `LOG_VERBOSITY` level (`quiet`, `normal`, or `verbose`). If not specified, **default to `verbose`**.

**`quiet`** — Mandatory posts only.

**`normal`** — Mandatory posts, plus build outcomes with error summaries, and notable decisions or deviations from the plan.

**`verbose`** — Everything from `normal`, plus:
- Post a `status_update` when you start a significant block of work.
- Post after completing each significant chunk.
- Post when you encounter something unexpected or make a non-obvious decision.
- Post build results with enough detail to diagnose without reading the full log.
- Post when resolving sub-agent mappings (which agent type you selected and why).
- Post when locating (or failing to locate) the task document or plan file you need.
- Post when any tool call fails: web search errors, connection timeouts, permission denials, unexpected exit codes.
- Post when retrying something, and what you changed on the retry.

These message posts are your observability trail. If you log what you are doing, _especially_ anything that fails, it gives the operator the opportunity to diagnose and fix these issues so you can complete your work. Silence during failures is the worst outcome: you struggle alone with no help, and the operator cannot tell whether you are stuck or making progress.

When in doubt about whether to post in verbose mode, post. The cost of a message is negligible; the cost of a silent 25-minute gap is far higher.
