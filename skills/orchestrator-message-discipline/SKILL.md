---
name: orchestrator-message-discipline
description: Complete message board protocol for the container orchestrator. Defines how to post, channels, message types, mandatory posts, and verbosity levels.
axis: protocol
---

<!-- TODO: Investigate content from standing instruction 02-messages.md. See defect #10. -->

## Message Board

The coordination server at `$SERVER_URL` provides a message board -- your **only communication channel with the human operator**. The operator reads `GET /messages/general` to understand what is happening. All posts are fire-and-forget (`|| true`).

### Identity Tag

Every message you post must be prefixed with your role tag: `[ORCHESTRATOR]`. This tag goes at the start of every `payload.message` string in `status_update` messages, and in the `notes` field of phase events. It allows the operator to distinguish your posts from sub-agent posts at a glance.

### How to Post

Use curl via the Bash tool:

```bash
curl -s -X POST "${SERVER_URL}/messages" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Name: ${AGENT_NAME}" \
  -H "X-Project-Id: ${PROJECT_ID}" \
  -d '{"channel":"general","type":"status_update","payload":{"message":"[ORCHESTRATOR] Status message here."}}' \
  --max-time 5 >/dev/null 2>&1 || true
```

`SERVER_URL`, `AGENT_NAME`, and `PROJECT_ID` are environment variables already set in the container. The `X-Project-Id` header is REQUIRED — without it the server scopes the message to the `default` project and the operator will not see it on their dashboard. The `|| true` makes the call non-fatal.

### Smoke Test -- First Message

Your very first action, before reading the plan or doing any work, is to post a hello message to the `general` channel:

```bash
curl -sf -X POST "${SERVER_URL}/messages" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Name: ${AGENT_NAME}" \
  -H "X-Project-Id: ${PROJECT_ID}" \
  -d '{"channel":"general","type":"status_update","payload":{"message":"[ORCHESTRATOR] Agent online. Beginning work."}}' \
  --max-time 5
```

This confirms you can reach the message board and that you are visible to the operator. If this post fails, stop immediately and report the error as your final output -- a broken message board means the operator has no visibility into your work.

### Channels

- **`general`** -- Phase transitions, failures, and final summaries. This is what the human reads.
- **`<role-name>`** (e.g. `implementer`, `reviewer`) -- Sub-agent progress. Post build results, investigation notes, and detailed progress here.

### Message Types

| type             | when to use                                             |
|------------------|---------------------------------------------------------|
| `phase_start`    | Beginning a new phase                                   |
| `phase_complete` | Phase passed build and review                           |
| `phase_failed`   | Phase could not be completed after retries              |
| `build_result`   | After each build attempt                                |
| `status_update`  | Progress narration, decisions, notable observations     |
| `summary`        | Final post when all work is done or the run has stopped |

### Payload Conventions

Keep payloads concise -- they are stored in SQLite. Use **exactly** these `type` and `payload` field names. Do not invent alternatives.

**Phase start:**
```json
{"channel":"general","type":"phase_start","payload":{"phase":"1","title":"Add retry logic","status":"starting","notes":"..."}}
```

**Phase complete:**
```json
{"channel":"general","type":"phase_complete","payload":{"phase":"1","title":"Add retry logic","build":"pass","review":"pass"}}
```

**Phase failed:**
```json
{"channel":"general","type":"phase_failed","payload":{"phase":"1","title":"Add retry logic","reason":"build failed after 3 retries"}}
```

**Build result:**
```json
{"channel":"general","type":"build_result","payload":{"phase":"1","outcome":"pass","errors":[]}}
```

**Status update:**
```json
{"channel":"general","type":"status_update","payload":{"message":"Your message text here"}}
```

**Summary:**
```json
{"channel":"general","type":"summary","payload":{"summary":"## Execution Summary\n..."}}
```

### Who Posts

You are the primary message poster. Your sub-agents do not post to the message board -- you read their output and relay the relevant parts. This avoids fragile multi-hop messaging chains.

### Mandatory Posts (all verbosity levels)

- `phase_start` and `phase_complete`/`phase_failed` for each phase.
- **Each reviewer's full output.** After every review cycle, post all three reviewers' complete reports as separate `status_update` messages tagged `[STYLE REVIEW]`, `[SAFETY REVIEW]`, `[CORRECTNESS REVIEW]`. This is a critical audit trail -- never omit, truncate, or summarize below the reviewer's own level of detail.
- `decomp_review_start` and the decomposition reviewer's full output tagged `[DECOMPOSITION REVIEW]` during the final stage.
- `summary` at the end.

### Verbosity Levels

Your prompt may include a `LOG_VERBOSITY` directive (`quiet`, `normal`, `verbose`). If not specified, **default to `verbose`**.

**`quiet`** -- Mandatory posts only.

**`normal`** -- Mandatory posts, plus:

- **After every sub-agent return**, post a structured digest: what it did, whether it built, build outcome (pass/fail + error count + key errors), files touched, decisions it made.
- **Before every re-delegation**, post why: what reviewer findings triggered it, what the implementer is being asked to fix, and which review cycle this is (e.g., "cycle 2/5").
- Any notable decisions you made.

**`verbose`** -- Everything from `normal`, plus:

- Comprehensive sub-agent summaries: observations, error messages, files created/modified, non-obvious choices, concerns raised. 5-15 lines per post.
- File lists and scope summaries before each delegation.
- Timing observations ("phase 2 took 3 build iterations").
- When a build succeeds but no new code was written since the last build, flag it -- this is a sign the implementer is not making progress.
- Post when any tool call fails: web search errors, connection timeouts, permission denials, unexpected exit codes.
- Post when retrying something, and what you changed on the retry.

These message posts are your observability trail. If you log what you are doing, _especially_ anything that fails, it gives the operator the opportunity to diagnose and fix these issues so you can complete your work. Silence during failures is the worst outcome: you struggle alone with no help, and the operator cannot tell whether you are stuck or making progress.

When in doubt about whether to post in verbose mode, post. The cost of a message is negligible; the cost of a silent 25-minute gap is far higher.
