# Debrief 0179 -- Phase 3: GET /agents/definitions/:type endpoint

## Task Summary

Implement Phase 3 of the agent-type-override task: create a `GET /agents/definitions/:type` Fastify route that compiles and returns agent definition files (markdown + meta.json sidecar) on demand. The endpoint uses the existing `compileAgent` function from `agent-compiler.ts` for dynamic agents and returns static agents directly.

## Changes Made

- **server/src/routes/agent-definitions.ts** (created): New Fastify plugin implementing `GET /agents/definitions/:type`. Validates `:type` against `AGENT_NAME_RE`. Checks `dynamic-agents/{type}.md` first, falls back to `agents/{type}.md`. Dynamic agents (with `skills` frontmatter) are compiled via `compileAgent` to a temp directory. Static agents return directly with default `{ "access-scope": "read-only" }` meta.

- **server/src/routes/index.ts** (modified): Added `agentDefinitionsPlugin` export.

- **server/src/index.ts** (modified): Registered `agentDefinitionsPlugin` with `{ config }` opts alongside other route plugins.

- **server/src/routes/agent-definitions.test.ts** (created): 6 tests covering: static agent return, dynamic agent compilation with skill content and access-scope, 404 for nonexistent types, 400 for invalid type names, dynamic-agents priority over static agents, and dynamic-agents files without skills treated as static.

## Design Decisions

- **Temp directory for compilation**: Dynamic agents are compiled to an `os.tmpdir()`-based temp dir, then cleaned up in a `finally` block. This avoids polluting the workspace with compiled artifacts.
- **Static fallback for dynamic files without skills**: If a file exists in `dynamic-agents/` but has no `skills` array (or empty skills), it is treated as static and returned with default read-only meta, rather than running it through the compiler (which would just copy it and emit a warning).
- **configDir as repo root**: The plugin derives `agents/`, `dynamic-agents/`, and `skills/` paths from `config.configDir`, which is the directory containing `scaffold.config.json` (typically the repo root). This matches how other plugins (e.g., `teams.ts`) derive directory paths.

## Build & Test Results

- **Build**: Clean (`npm run build` succeeds with no errors).
- **Tests**: 6/6 pass for `agent-definitions.test.ts`. Cross-checked with `container-settings.test.ts`, `health.test.ts`, and `config.test.ts` (all pass). Pre-existing failures in `agents.test.ts` (POST /agents/:name/sync) are unrelated git environment issues in the Docker container.

## Open Questions / Risks

- The `compileAgent` function writes to stderr for agents with no skills. In the endpoint context this goes to the server log, which is acceptable but could be noisy if called frequently for no-skills agents. The current implementation avoids this by treating no-skills dynamic-agents files as static.

## Suggested Follow-ups

- None required for this phase. The endpoint is ready for Phase 4+ consumers.
