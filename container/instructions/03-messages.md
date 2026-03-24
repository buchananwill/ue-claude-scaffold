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

- **`general`** — Phase transitions, failures, and final summaries. This is what the human reads.
- **`<role-name>`** (e.g. `implementer`, `reviewer`) — Sub-agent progress. Post build results, investigation notes, and
  detailed progress here.

## Message types

| type             | when to use                                             |
|------------------|---------------------------------------------------------|
| `phase_start`    | Beginning a new phase                                   |
| `phase_complete` | Phase passed build and review                           |
| `phase_failed`   | Phase could not be completed after retries              |
| `build_result`   | After each build attempt                                |
| `status_update`  | Progress narration, decisions, notable observations     |
| `summary`        | Final post when all work is done or the run has stopped |

## Payload conventions

Keep payloads concise — they are stored in SQLite. Include at minimum:

- **Phase events**: `{ "phase": "<id>", "title": "<title>", "status": "...", "notes": "..." }`
- **Build results**: `{ "phase": "<id>", "outcome": "pass" | "fail", "errors": ["..."] }`
- **Status updates**: `{ "message": "<your message>" }`
- **Summary**: `{ "summary": "<markdown block>" }`

## Who posts

The **orchestrator** is the primary message poster. It posts `phase_start`, `phase_complete`/`phase_failed`, and
`summary` at the mandatory points, and relays sub-agent output as `status_update` posts in between.

Sub-agents (implementer, reviewer, tester) do not post to the message board. The orchestrator reads their output and
relays the relevant parts. This avoids fragile multi-hop messaging chains — the orchestrator is the single entity that
reliably has the server URL, agent name, and conversation context.

## Verbosity

Your delegation prompt may include a `LOG_VERBOSITY` level (`quiet`, `normal`, or `verbose`). This controls how much
you post beyond the mandatory posts above.

**`quiet`** — Mandatory posts only.

**`normal`** — Mandatory posts, plus:
- Build outcomes with error summaries.
- Notable decisions or deviations from the plan.

**`verbose`** — Everything from `normal`, plus:
- Post a `status_update` to your channel when you start a significant block of work (e.g. "Reading 5 header files to understand component model", "Moving 12 functions from BuildableActorViews.h to .cpp").
- Post after completing each significant chunk (e.g. "Finished moving BuildableActorViews.h functions — 18 moved, 3 templates left in header").
- Post when you encounter something unexpected or make a non-obvious decision (e.g. "Found additional dependency on FBuildableSnappingSocket — adding forward declaration").
- Post build results with enough detail to diagnose without reading the full log (error count, first few errors, files involved).
- Think of your channel as a running commentary for someone who wants to follow along without watching the raw tool calls.

When in doubt about whether to post in verbose mode, post. The cost of a message is negligible; the cost of a silent 25-minute gap during debugging is an operator who can't tell if you're stuck or making progress.
