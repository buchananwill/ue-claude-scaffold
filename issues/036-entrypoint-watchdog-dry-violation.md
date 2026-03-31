---
title: "Claude run-and-watchdog pattern duplicated in entrypoint.sh"
priority: low
reported-by: interactive-session
date: 2026-03-31
status: open
---

# DRY violation: duplicated Claude run-and-watchdog block

## Problem

The pattern of starting Claude with `tee` to a log file, launching `_watch_for_stop` as a background job, `wait`-ing for both PIDs, capturing `EXIT_CODE`, and handling `/tmp/.stop_requested` appears in near-identical form in both:

- `run_claude_task` (worker mode) — ~lines 477-495
- `run_chat_agent` (chat/plan mode) — ~lines 604-629

The only structural difference is that `run_claude_task` builds `CLAUDE_ARGS` as an array while `run_chat_agent` inlines the flags.

## Suggested fix

Extract a `_run_claude_with_watchdog` function that accepts Claude arguments as `"$@"` and sets `EXIT_CODE` on return. Both `run_claude_task` and `run_chat_agent` call it. Mechanical extraction — the stop-detection and watchdog teardown logic move once to the new function.
