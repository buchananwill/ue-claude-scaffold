# Debrief 0001 -- Remove dead --plan / TASKS_PATH plumbing

## Task Summary

Issue #038: The `--plan` flag in `launch.sh` and its associated `TASKS_PATH` infrastructure are dead code. The entrypoint exclusively polls the task queue via `POST /tasks/claim-next` and never reads from the `/task` volume mount or `TASK_PROMPT_FILE`. The task was to remove all of this dead plumbing across 9 files.

## Changes Made

- **launch.sh** -- Removed `--plan PATH` from CLI parsing, usage text, examples. Removed `_CLI_PLAN` variable, `PLAN_PATH` assignment and validation block, `TASKS_PATH` resolution from both multi-project and legacy config paths, `TASKS_PATH` validation block, `TASKS_PATH` and `PLAN_PATH` from dry-run output, plan file copy block, `TASK_PROMPT_FILE` environment variable from generated compose, `TASKS_PATH` volume mount from generated compose, `TASKS_PATH` from all export statements, and `TASKS_PATH` from team member launch env.
- **scaffold.config.example.json** -- Removed `tasksPath` fields from three project configs (my-ue-game, my-ue-game-dashboard, side-project).
- **container/docker-compose.example.yml** -- Removed `TASK_PROMPT_FILE=/task/prompt.md` environment variable and `${TASKS_PATH}:/task:ro` volume mount.
- **server/src/config.ts** -- Removed `tasksPath?: string` from `ProjectConfig` interface, removed `tasksPath` from legacy config synthesis in `loadConfig()`, removed `tasksPath` from `parseProjectConfig()`.
- **server/src/config.test.ts** -- Removed `tasksPath` assertion from legacy config test.
- **CLAUDE.md** -- Updated launch examples to remove `--plan` references. Replaced "Two Execution Modes" section with "Task-Queue Execution" describing the current workflow.
- **README.md** -- Updated Quick Start and Scripts sections to remove `--plan` from launch examples.
- **setup.sh** -- Updated "Next steps" help text to remove `--plan` from launch example.
- **tasks/example-prompt.md** -- Updated guidance to reference task queue ingestion instead of `TASKS_PATH` volume mount.

## Design Decisions

- Kept the `tasks` top-level field in `ScaffoldConfig` (with `path` and `planBranch`) since `planBranch` is still used and `tasks.path` may still be referenced elsewhere. Only removed `tasksPath` from `ProjectConfig` and multi-project parsing since those were the dead paths.
- In CLAUDE.md, replaced the dual "Plan mode / Worker mode" description with a unified "Task-Queue Execution" section since both modes now use the task queue.
- Left `WORKER_MODE`, `--worker`, and `--pump` flags intact as they control task queue behavior (single vs continuous polling).

## Build & Test Results

Pending initial build.

## Open Questions / Risks

- The `tasks.path` field in `ScaffoldConfig` (top-level config) is retained because it feeds `planBranch` which is still used. If `tasks.path` itself is also dead, that would be a separate cleanup.
- `container/entrypoint.sh` may still reference `TASK_PROMPT_FILE` -- not in scope for this issue but worth checking.

## Suggested Follow-ups

- Check `container/entrypoint.sh` for any remaining references to `TASK_PROMPT_FILE` or `/task` mount.
- Consider removing the top-level `tasks.path` config field if it's also dead code.
- Update `scaffold.config.schema.json` if one exists to remove `tasksPath` from the schema.
