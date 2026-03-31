---
title: "entrypoint.sh (749 lines) and launch.sh (711 lines) need decomposition"
priority: medium
reported-by: interactive-session
date: 2026-03-31
status: open
---

# Decompose entrypoint.sh and launch.sh

## Problem

Both files have grown well past the 300-line threshold identified in issue #025. The prior audit (2026-03-22) recorded them at 392 and 350 lines respectively and marked both "Leave." They have since roughly doubled.

## Current state

### `container/entrypoint.sh` — 749 lines, 5 responsibility groups

1. **Workspace bootstrap** — git clone, checkout, pull, config, exclude
2. **Hook assembly** — deprecation shim, dynamic settings.json via jq
3. **Server registration + helpers** — `_curl_server`, `_post_status`, `_detect_abnormal_exit`, `_post_abnormal_shutdown_message`, `_shutdown`, `_watch_for_stop`
4. **Worker task polling** — `poll_and_claim_task`, `run_claude_task`
5. **Chat-agent execution** — `run_chat_agent`, standing-instructions assembly

Proposed split: extract groups 2, 4, and 5 into sourced scripts (`container/setup-hooks.sh`, `container/run-worker-task.sh`, `container/run-chat-agent.sh`). `entrypoint.sh` becomes the thin dispatcher.

### `launch.sh` — 711 lines, 5 responsibility groups

1. **CLI parsing**
2. **Config loading and resolution** — `.env`, `scaffold.config.json`, project-level fields, validation
3. **Hook resolution** — `_validate_hook_values`, `_resolve_hook_value`, `resolve_hooks`
4. **Team-launch mode** — brief validation, team registration, room creation, `launch_team_member`, member iteration
5. **Single/parallel agent launch** — branch setup, docker-compose invocation, output summary

Proposed split: extract groups 3 and 4 into sourced scripts (`scripts/resolve-hooks.sh`, `scripts/launch-team.sh`). `launch.sh` retains CLI parsing, config loading, and single/parallel dispatch (~400 lines).

## Relation to issue #025

Issue #025's audit should be updated to reflect the new line counts and move both files from Tier 3 to Tier 1.
