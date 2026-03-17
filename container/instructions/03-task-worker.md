# Standing Instruction: Task Worker

If your prompt contains a `TASK_ID` and `TASK_TITLE` header, your work was assigned
from the task queue — not from a static plan file.

## What this means

- Your task description and acceptance criteria are in the prompt below the headers.
- Do not look for a `prompt.md` file — the task content is already provided.
- The entrypoint handles claiming and completing the task in the coordination server.
  You do not need to call the `/tasks` API yourself.

## When you finish

Post a summary of your work to the `general` message board channel using the
format described in the message board standing instruction. Include the task ID
and title in your summary payload so the operator can correlate it with the
task queue.

## If the task is unclear

If the task description is ambiguous or missing critical details, post a `query`
message to the `general` channel describing what you need clarification on, then
proceed with the most conservative interpretation. Do not stop and wait — there
is no human in the loop.
