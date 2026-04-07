# Debrief 0087 — Entrypoint Decomposition into Lib Modules

## Task Summary

Phase 12 of the shell script decomposition plan: decompose `container/entrypoint.sh` (1000 lines) into six sourced library files under `container/lib/`, reducing entrypoint.sh to a flat dispatcher of 200 lines or fewer.

## Changes Made

- **container/lib/env.sh** (created, 39 lines): Environment variable defaults, validation (AGENT_TYPE required), persistent logging setup, and banner output. Extracted from entrypoint.sh lines 1-38.

- **container/lib/workspace-setup.sh** (created, 240 lines): Functions `_setup_workspace` (clone/checkout/exclude), `_snapshot_agents` (copy agent definitions), `_setup_hooks` (access scope + hook settings.json generation), `_setup_mcp_config` (MCP JSON), `_symlink_plugins` (read-only plugin mounts), `_apply_readonly_lockdown` (Source/ chmod), `_print_diagnostics` (pre-launch info). Extracted from entrypoint.sh lines 40-209 plus 96-188 plus 419-448 plus 862-870.

- **container/lib/registration.sh** (created, 174 lines): Functions `_curl_server`, `_post_status`, `_detect_abnormal_exit`, `_post_abnormal_shutdown_message`, `_shutdown`, `_watch_for_stop`, `_register_agent`, `_smoke_test_messages`. Extracted from entrypoint.sh lines 211-383.

- **container/lib/finalize.sh** (created, 23 lines): Function `_finalize_workspace` — commit, audit log, push. Consolidated from the duplicated final-commit-and-push blocks in `run_claude_task` and `run_chat_agent`.

- **container/lib/run-claude.sh** (created, 218 lines): Functions `_build_task_prompt_prefix`, `_build_task_prompt`, `_build_chat_prompt`, and `_run_claude <prompt> <mode>`. Collapses `run_claude_task`, `run_chat_agent`, and the direct-prompt block into a single parameterized function. Mode can be `task`, `chat`, or `direct`.

- **container/lib/pump-loop.sh** (created, 156 lines): Functions `poll_and_claim_task` and `_pump_iteration`. The iteration function returns status via the `PUMP_STATUS` variable with values: `continue`, `paused`, `stop`, `circuit_break`. Includes the circuit-breaker logic, workspace reset, pause detection.

- **container/entrypoint.sh** (rewritten, 80 lines): Flat dispatcher that sources all lib files, calls setup functions in order, then dispatches to the appropriate mode (direct/chat/pump/single-task).

## Design Decisions

1. **PUMP_STATUS as a variable rather than exit code**: Shell functions can only return 0-255, and we need four distinct states. Using a global variable is the standard bash pattern for rich return values.

2. **_run_claude unifies all three invocation paths**: The direct, task, and chat modes all shared identical Claude CLI invocation, watchdog, and exit-handling logic. The only differences were: (a) prompt content (handled by caller), (b) whether to finalize workspace (skipped for `direct` mode), and (c) whether to report task completion (only for `task` mode).

3. **Prompt building extracted into functions**: `_build_task_prompt`, `_build_chat_prompt`, and `_build_task_prompt_prefix` are callable from the dispatcher, keeping prompt assembly separate from invocation.

4. **trap _shutdown EXIT placed after registration**: The shutdown function depends on `_curl_server` being defined and the agent being registered. The trap is set in entrypoint.sh after `_register_agent` completes.

## Build & Test Results

All shell files pass `bash -n` syntax checking:
- `container/entrypoint.sh` -- OK (80 lines, well under 200-line target)
- `container/lib/env.sh` -- OK
- `container/lib/workspace-setup.sh` -- OK
- `container/lib/registration.sh` -- OK
- `container/lib/finalize.sh` -- OK
- `container/lib/run-claude.sh` -- OK
- `container/lib/pump-loop.sh` -- OK
- `launch.sh`, `setup.sh`, `status.sh`, `stop.sh` -- all OK (unchanged)

## Open Questions / Risks

1. **SCRIPT_DIR detection**: The new entrypoint uses `$(dirname "${BASH_SOURCE[0]}")` to locate lib files. This works when entrypoint.sh is invoked directly but may need adjustment if it's ever sourced from a different directory. The Docker image always runs it directly, so this should be fine.

2. **Global variable sharing**: The lib files rely on globals (WORK_BRANCH, AGENT_NAME, etc.) being set by env.sh and available in the sourcing shell. This is the standard pattern for bash library decomposition but means the source order matters.

3. **trap RETURN in _detect_abnormal_exit / _post_abnormal_shutdown_message**: These use `trap 'rm -f ...' RETURN` for temp file cleanup, which works correctly inside sourced functions.

## Suggested Follow-ups

- Add integration tests that source the lib files in isolation to verify they parse and export expected functions.
- Consider adding a `container/lib/README.md` documenting the source order and dependency graph (if the operator requests it).
