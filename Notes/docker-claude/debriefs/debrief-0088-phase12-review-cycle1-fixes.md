# Debrief 0088 -- Phase 12 Review Cycle 1 Fixes

## Task Summary

Fix all in-scope review findings from Phase 12 cycle 1 across the container shell library files. The findings span style, safety, and correctness categories.

## Changes Made

- **container/lib/env.sh**: Added AGENT_NAME validation regex, added zero-value initializations for cross-module globals (ABNORMAL_REASON, CURRENT_TASK_*, PUMP_STATUS, SESSION_TOKEN, AGENTS_DIR).
- **container/lib/run-claude.sh**: Added `local` to CLAUDE_ARGS, CLAUDE_PID, WATCHDOG_PID, EXIT_CODE, CLAUDE_START_TS, CLAUDE_END_TS, CLAUDE_ELAPSED. Set ABNORMAL_SHUTDOWN on stop_requested. Changed finalize guard from `!= "direct"` to `= "task"`. Replaced raw JSON interpolation in task complete/fail payloads with jq -n.
- **container/lib/workspace-setup.sh**: Removed AGENTS_DIR assignment (now in env.sh). Added `local` to ACCESS_SCOPE, META_FILE, PRE_BASH, PRE_MATCHERS, POST_MATCHERS in _setup_hooks(). Removed _setup_mcp_config, _print_diagnostics, _apply_readonly_lockdown (moved to post-setup.sh).
- **container/lib/post-setup.sh**: Created new file with _setup_mcp_config (now uses jq -n instead of heredoc), _print_diagnostics, and _apply_readonly_lockdown.
- **container/lib/pump-loop.sh**: Renamed poll_and_claim_task to _poll_and_claim_task. Updated function comment to remove `paused` from PUMP_STATUS enum.
- **container/lib/registration.sh**: Replaced raw JSON interpolation in _post_status with jq -n --arg. Replaced raw JSON interpolation in _register_agent with jq -n --arg for all fields. Added local to _register_agent internal variables.
- **container/entrypoint.sh**: Added source for post-setup.sh. Renamed poll_and_claim_task references to _poll_and_claim_task. Removed `paused` case arm from PUMP_STATUS. Added default `*` case arm with error message.

## Design Decisions

- Created `container/lib/post-setup.sh` rather than putting functions in registration.sh, since MCP config / diagnostics / lockdown are conceptually distinct from server registration.
- AGENTS_DIR declared as a global in env.sh since it is used across _snapshot_agents and _setup_hooks in different modules.

## Build & Test Results

All shell files pass `bash -n` syntax checking.

## Open Questions / Risks

None.

## Suggested Follow-ups

- The _smoke_test_messages function in registration.sh also uses raw JSON interpolation but was not in scope for this review cycle.
