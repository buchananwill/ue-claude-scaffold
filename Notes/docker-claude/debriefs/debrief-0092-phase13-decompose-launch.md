# Debrief 0092 -- Phase 13: Decompose launch.sh

## Task Summary

Decompose launch.sh (698 lines) into reusable library modules and a flat dispatcher script (target <=200 lines). Create static docker-compose template files to replace the dynamically generated compose YAML.

## Changes Made

- **scripts/lib/parse-launch-args.sh** (created): CLI argument parser extracted from launch.sh L49-115. Provides `_parse_launch_args` and `_launch_usage`.
- **scripts/lib/launch-container.sh** (created): Container launch helper with `_compose_project_name` and `_launch_container`. Accepts compose file flags and env overrides via `--` separator.
- **scripts/lib/print-resolved-config.sh** (created): Pretty-printer for resolved config, used in both dry-run and actual launch paths.
- **scripts/lib/resolve-config.sh** (created): Project config resolution from scaffold.config.json. Provides `_resolve_project_config`, `_resolve_agent_vars`, `_validate_required_config`, and `_validate_hook_values`.
- **scripts/lib/resolve-hooks.sh** (created): Hook resolution cascade (system -> project -> team -> member -> CLI). Provides `_resolve_hooks` and `_resolve_hook_value`.
- **scripts/lib/compile-agents.sh** (created): Dynamic agent compilation helper. Provides `_compile_agents`.
- **scripts/lib/branch-setup.sh** (created): Bare repo branch management. Provides `_setup_branch` and `_validate_bare_repo`.
- **container/docker-compose.template.yml** (created): Static base compose template with all environment variables and core volume mounts.
- **container/docker-compose.engine.yml** (created): Engine overlay that adds the UE engine volume mount, used with `docker compose -f base -f engine`.
- **launch.sh** (rewritten): Flat dispatcher that sources libraries, parses args, resolves config/hooks/branches, compiles agents, and launches. Final size: 144 lines.

## Design Decisions

1. **_launch_container signature change**: The new version takes compose_dir and compose file names as positional args, with env overrides after a `--` separator. This is more explicit than the old version which relied on exported env vars and a hardcoded compose path.

2. **Kept config resolution in shell**: The plan suggested fetching config from the server via `GET /config/:projectId`, but the server endpoint returns nulls for `logsPath`, `agentType`, and `hooks`. Rather than patching the server (out of scope), the config resolution reads scaffold.config.json directly via the new `_resolve_project_config` helper.

3. **_generate_compose removed entirely**: Replaced with static `docker-compose.template.yml` (base) + `docker-compose.engine.yml` (overlay). The engine overlay is only included when `UE_ENGINE_PATH` is set.

4. **Print config on actual launch too**: Per Step 72, `_print_resolved_config` is called in both the dry-run and actual launch paths so users always see what was resolved.

## Build & Test Results

All shell scripts pass `bash -n` syntax validation:
- launch.sh (144 lines, well under 200 target)
- All 8 new/modified lib files
- All existing scripts (setup.sh, status.sh, stop.sh, launch-team.sh, ingest-tasks.sh, entrypoint.sh)

## Open Questions / Risks

- The `launch-team.sh` script still has its own inline docker compose invocation rather than using `_launch_container` from the new lib. It could be updated to source the lib, but that's a separate concern.
- The server's `GET /config/:projectId` endpoint returns nulls for hooks, agentType, and logsPath. When these are populated in a future phase, launch.sh could be further simplified.

## Suggested Follow-ups

- Update `launch-team.sh` to source `scripts/lib/launch-container.sh` and use `_launch_container`.
- Populate the missing fields in `resolveProjectConfig` so the shell script can delegate more to the server.
- Remove `container/docker-compose.example.yml` or update its header to reference the new template.
