# Debrief 0058 - Phase 5: Server-side Container Settings Rendering

## Task Summary
Move the container settings.json and mcp.json rendering from shell/jq commands in entrypoint.sh into TypeScript functions with tests and REST endpoints, so containers can fetch their settings with a single HTTP call.

## Changes Made
- **server/src/container-settings.ts** (created): Exports `buildSettingsJson(SettingsOpts)` and `buildMcpJson(McpOpts)` that produce the same JSON structures as the jq commands in entrypoint.sh.
- **server/src/container-settings.test.ts** (created): 11 tests covering all flag combinations for settings (buildIntercept, cppLint, gitSync, workspaceReadonly) and MCP (chatRoom set/null/undefined).
- **server/src/routes/container-settings.ts** (created): Fastify plugin with `GET /agents/:name/settings.json` and `GET /agents/:name/mcp.json` routes accepting query params.
- **server/src/routes/index.ts** (modified): Added containerSettingsPlugin export.
- **server/src/index.ts** (modified): Imported and registered containerSettingsPlugin.

## Design Decisions
- Hook ordering matches entrypoint.sh: guard-branch first (if writable), then intercept/block-push (if buildIntercept), then inject-agent-header always last.
- The `toBool` helper treats both `"true"` and `"1"` as truthy for query params, defaulting to false.
- For `GET /agents/:name/mcp.json`, if `agentName` query param is omitted, falls back to the `:name` route param.
- The routes don't require agent registration or DB lookups -- they are pure rendering endpoints.

## Build & Test Results
- Build: SUCCESS (`npm run build` -- clean, no errors)
- Tests: 11 passed, 0 failed (`npx tsx --test src/container-settings.test.ts`)

## Open Questions / Risks
- Step 31 (shell script changes to use these endpoints) is explicitly deferred to a later phase.
- Phase 8 will update `lint-cpp-diff.py` references if the linter is rewritten to .mjs.

## Suggested Follow-ups
- Step 31: Update entrypoint.sh to curl these endpoints instead of building JSON with jq.
- Add route-level tests that exercise the HTTP endpoints via app.inject().
