---
title: "Test failure output references host paths the container agent cannot read"
priority: high
reported-by: interactive-session
date: 2026-05-03
status: open
---

# Test failure output references host paths the container agent cannot read

## Problem

When a UE automation test fails to emit a completion event — e.g. the engine
crashes or the test deadlocks before the test framework logs a result — the
host-side test runner script returns a structured-but-unactionable summary to
the agent. The summary tells the agent that 1 test was expected, 0 were
accounted for, names the likely cause as a crash, and points at a host
filesystem path for the engine log:

```
=== UE Automation Test Results: INCOMPLETE ===
Filter: Resort.Behaviour.Scheduler.Canary
Total: 1  Passed: 0  Failed: 0  Not Run: 0

--- INCOMPLETE: 1 tests did not emit completion ---
  Expected 1, accounted for 0 (passed+failed+not_run).
  Likely cause: a test crashed the engine before logging completion.
  Inspect the log around the next queued test for the crash signal.

Log: D:\Coding\resort_game\staging\agent-2\Saved\Logs\PistePerfect_5_7.log
```

The agent ran inside a Docker container. It cannot read `D:\…` paths on the
host. The runner has effectively told the agent "your test crashed, the
diagnostic information is in a file you cannot reach." The agent has no path
to investigate the crash, cannot determine which assertion or async wait
deadlocked, and cannot fix its code.

In this specific incident the non-completion was caused by deadlocking async
code — and async code was exactly the area the agent had been editing. The
crash signal in the engine log would have pointed straight at the offending
construct. Without it, the agent is blind to the consequences of its own
changes.

## Why it is happening

The scaffold's `/test` endpoint is a thin shell around a host-configured test
script. Whatever the script writes to stdout/stderr is what the agent sees.
The current script reports incompleteness as a metadata summary plus a host
path; it never inlines log content. Even if the agent had the discipline to
parse the path and ask for it, there is no mechanism in the scaffold for the
agent to fetch arbitrary files from the host.

## Required behavior

- A `/test` response that indicates a crashed or incomplete test must contain
  enough log context, inline in the response payload, for the agent to
  identify the failing operation in its own code without any further host
  filesystem access. "Enough" means at minimum the engine log lines around
  the crash signal, the stack trace if one was emitted, and whatever
  assertion or async-await context the engine logged immediately before
  termination.

- Agent observability must not depend on the agent having access to host
  paths. Any diagnostic the agent is expected to act on must be transmitted
  through the coordination server's response or message-board surface.

- The agent must be able to distinguish a test that crashed mid-run from a
  test that ran to completion and produced a real failure. Both surface as
  `success: false` today; the response shape must let the agent treat them
  differently (a crash points at infrastructure or async-lifetime bugs, a
  completed failure points at the assertion that failed).

## Sequencing notes

- The host-side test runner script lives in the target project repository
  (resort_game), not in this scaffold. Project-side changes can land
  independently.

- The scaffold-side enhancement — having the `/test` endpoint enrich
  responses with log context drawn from the staging worktree — is additive
  and does not block the project-side change.
