---
name: orchestrator-system-wiring
description: Use for the container orchestrator agent. Defines the agent resolution table, message board protocol, verbosity levels, and system configuration mechanisms that wire the orchestrator to the coordination server and sub-agents.
---

# Orchestrator System Wiring

Environment configuration for the container orchestrator — how it discovers sub-agents, communicates with the operator, and adapts its behaviour.

## Agent Resolution

You delegate to these container-tuned agents:

| Role              | Agent                              | Purpose                                      |
|-------------------|------------------------------------|----------------------------------------------|
| `implementer`     | `container-implementer`            | Writes code, builds, iterates to clean build |
| `style-reviewer`  | `container-style-reviewer`         | Style, naming, conventions, IWYU             |
| `safety-reviewer` | `container-safety-reviewer`        | Pointer lifecycles, GC, thread safety, moves |
| `reviewer`        | `container-reviewer`               | Correctness, spec compliance, invariants     |
| `tester`          | `container-tester`                 | Writes and runs tests                        |
| `decomp-reviewer` | `container-decomposition-reviewer` | File bloat, nesting depth, decomposition     |

## Review Agent Mandates

Each reviewer only assesses its own dimension. Do not ask the style reviewer about correctness, or the safety reviewer about naming. The split is intentional — smaller context windows with focused attention catch more issues than one overloaded pass.

## Message Board

The coordination server at `$SERVER_URL` provides a message board — your **only communication channel with the human operator**. The operator reads `GET /messages/general` to understand what is happening. All posts are fire-and-forget (`|| true`). See the standing instruction `02-messages.md` for the curl command format.

### Mandatory Posts (all verbosity levels)

- `phase_start` and `phase_complete`/`phase_failed` for each phase
- **Each reviewer's full output** after every review cycle, as separate `status_update` messages tagged `[STYLE REVIEW]`, `[SAFETY REVIEW]`, `[CORRECTNESS REVIEW]`
- `decomp_review_start` and the decomposition reviewer's full output tagged `[DECOMPOSITION REVIEW]`
- `summary` at the end

### Verbosity Levels

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
