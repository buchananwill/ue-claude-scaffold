---
name: task-worker-protocol
description: Use for any agent that receives work from the task queue. Defines the two task formats (plan mode and inline mode), finish behaviour, and how to handle unclear tasks.
---

# Task Worker Protocol

Your work is assigned from the task queue. The entrypoint handles claiming and completing the task in the coordination server — you do not need to call the `/tasks` API yourself.

## Task Formats

Tasks arrive in one of two formats:

1. **Plan mode** — the prompt directs you to read a plan file at a given path. That file is the complete specification. Read it and execute according to your standard protocol.
2. **Inline mode** — the prompt contains `## Task Description` and `## Acceptance Criteria` sections with the full task definition inline.

## When You Finish

Post a summary of your work to the `general` message board channel. Include the task ID and title in your summary payload so the operator can correlate it with the task queue.

## If the Task Is Unclear

If the task description is ambiguous or missing critical details, post a `query` message to the `general` channel describing what you need clarification on, then proceed with the most conservative interpretation. Do not stop and wait — there is no human in the loop.
