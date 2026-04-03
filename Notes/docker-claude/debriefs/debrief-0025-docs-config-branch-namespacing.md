# Debrief 0025 -- Documentation and Config Examples for Project-Namespaced Branches

## Task Summary

Phase 5 of the server-multi-tenancy plan: update config examples, CLAUDE.md, skill files, and README.md to reflect the new project-namespaced branch naming convention (`docker/{project-id}/current-root`, `docker/{project-id}/{agent-name}`).

## Changes Made

- **scaffold.config.example.json**: Changed `tasks.seedBranch` from `docker/current-root` to `docker/{project-id}/current-root`. Renamed `container.defaultBranch` to `container.seedBranch` with the namespaced pattern.
- **CLAUDE.md**: Updated Git Data Flow diagram, branch model section, API endpoint descriptions, `--fresh` flag description, and all branch references to use the `docker/{project-id}/...` pattern.
- **skills/container-git-write/SKILL.md**: Updated all branch references (template and concrete examples) to namespaced pattern.
- **skills/container-git-environment/SKILL.md**: Updated all branch references to namespaced pattern.
- **skills/container-git-readonly/SKILL.md**: Updated all branch references to namespaced pattern.
- **skills/container-git-build-intercept/SKILL.md**: Updated all branch references to namespaced pattern.
- **skills/cleanup-session-protocol/SKILL.md**: Updated `git fetch` example to use namespaced branch.
- **README.md**: Renamed `container.defaultBranch` to `container.seedBranch` in the config table.

## Design Decisions

- Renamed `defaultBranch` to `seedBranch` in both the config example and README table, matching the `tasks.seedBranch` field already present in the config.
- Updated concrete git examples (e.g., `docker/agent-2:path/to/file.ts`) to include the `{project-id}` segment for consistency.

## Build & Test Results

- TypeScript typecheck (`npx tsc --noEmit`): SUCCESS, no errors.
- No test changes needed -- this phase is documentation-only.

## Open Questions / Risks

- None. All changes are documentation and config examples only.

## Suggested Follow-ups

- None for this phase.
