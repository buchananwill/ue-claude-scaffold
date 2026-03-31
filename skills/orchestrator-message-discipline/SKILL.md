---
name: orchestrator-message-discipline
description: Use for any container orchestrator. Defines what to post to the message board and when — mandatory post requirements, reviewer output relaying, and verbosity levels. Compose with message-board-protocol (how to post) and a system-wiring skill (which agents to delegate to).
axis: protocol
---

# Orchestrator Message Discipline

What the orchestrator must post to the message board, and at what verbosity. Compose with `message-board-protocol` for the curl mechanics.

## Mandatory Posts (all verbosity levels)

- `phase_start` and `phase_complete`/`phase_failed` for each phase
- **Each reviewer's full output** after every review cycle, as separate `status_update` messages tagged `[STYLE REVIEW]`, `[SAFETY REVIEW]`, `[CORRECTNESS REVIEW]`
- `decomp_review_start` and the decomposition reviewer's full output tagged `[DECOMPOSITION REVIEW]`
- `summary` at the end

## Verbosity Levels

Your prompt may include a `LOG_VERBOSITY` directive (`quiet`, `normal`, `verbose`). If not specified, **default to `verbose`**.

**`quiet`** — Mandatory posts only.

**`normal`** — Mandatory posts, plus:
- After every sub-agent return: structured digest (what it did, build outcome, files touched, decisions)
- Before every re-delegation: why (which findings triggered it, which cycle this is)
- Any notable decisions you made

**`verbose`** — Everything from `normal`, plus:
- Comprehensive sub-agent summaries (5-15 lines per post)
- File lists and scope summaries before each delegation
- Timing observations
- Stall detection (build succeeds but no new code since last build)
