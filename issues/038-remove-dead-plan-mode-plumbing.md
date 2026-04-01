---
title: Remove dead --plan / TASKS_PATH plumbing
priority: medium
reported-by: interactive session
date: 2026-04-01
---

## Summary

The `--plan` flag in `launch.sh` and its associated `TASKS_PATH` infrastructure are dead code. The entrypoint exclusively polls the task queue via `POST /tasks/claim-next` and never reads from the `/task` volume mount or `TASK_PROMPT_FILE`.

## Dead code inventory

### launch.sh
- `--plan PATH` CLI flag and `PLAN_PATH` variable
- `TASKS_PATH` resolution from `scaffold.config.json` (both multi-project and legacy paths)
- `TASKS_PATH` validation in the required-vars block (lines 272-278)
- Plan file copy logic (lines 581-588): copies plan to `TASKS_PATH/prompt.md`
- `TASKS_PATH` export

### scaffold.config.json
- `tasksPath` field in project configs (currently only set on `scaffold`)

### docker-compose (generated and example)
- `TASK_PROMPT_FILE=/task/prompt.md` environment variable
- `${TASKS_PATH}:/task:ro` volume mount

### entrypoint.sh
- `TASK_PROMPT_FILE` is never referenced. The entrypoint calls `poll_and_claim_task()` which hits the coordination server API.

## Correct workflow

1. Ingest tasks via `POST /tasks` (with `sourcePath` pointing to a committed plan, or inline description/acceptanceCriteria)
2. Launch container (no `--plan` needed)
3. Container polls `POST /tasks/claim-next`, claims a task, executes it

## What to do

- Remove `--plan`, `TASKS_PATH`, `TASK_PROMPT_FILE`, and the `/task` volume mount
- Remove `tasksPath` from `scaffold.config.json` schema and project configs
- Update `--help` usage text
- Consider whether `launch.sh` should optionally POST a task to the server as a convenience (replacing the copy-file approach with proper task queue ingestion)
