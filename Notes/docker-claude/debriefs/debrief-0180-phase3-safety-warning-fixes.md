# Debrief 0180 -- Phase 3 Safety Warning Fixes in agent-definitions.ts

## Task Summary

Fix three WARNING-level safety review findings in `server/src/routes/agent-definitions.ts`:
1. W1: 404 error echoes user-supplied `:type` parameter verbatim.
2. W2: Synchronous blocking I/O in async handler (`existsSync`, `readFileSync`, `mkdtempSync`, `rmSync`).
3. W3: Unguarded `JSON.parse` on sidecar `.meta.json` file.

## Changes Made

- **server/src/routes/agent-definitions.ts** (modified):
  - W1: Changed `reply.notFound(\`Agent type '\${type}' not found\`)` to generic `reply.notFound('Agent type not found')`.
  - W2: Switched import from `node:fs` to `node:fs/promises`. Replaced `existsSync` with an async `fileExists` helper using `fs.access`. Replaced `readFileSync` with `fs.readFile`, `mkdtempSync` with `fs.mkdtemp`, and `rmSync` with `fs.rm`. `compileAgent` (from agent-compiler.ts) remains synchronous as instructed.
  - W3: Wrapped `JSON.parse(metaRaw)` in a try/catch that throws `app.httpErrors.internalServerError('Failed to parse compiled agent metadata')` on parse failure.

## Design Decisions

- Created a small `fileExists` async helper at module scope rather than inlining `fs.access` try/catch twice (for dynamic and static path checks). This keeps the handler body readable.
- Split the `readFile` + `JSON.parse` into two statements (`metaRaw` then `JSON.parse(metaRaw)`) so the try/catch around `JSON.parse` does not accidentally catch `readFile` errors.
- The `compileAgent` call remains synchronous per the task instructions (do not modify agent-compiler.ts).

## Build & Test Results

- **Build**: `npm run build` -- SUCCESS (clean, no errors).
- **Tests**: `npx tsx --test src/routes/agent-definitions.test.ts` -- 6/6 passed, 0 failed.
- **Full suite**: 4 pre-existing failures in `POST /agents/:name/sync` due to missing git user config in the container environment. Unrelated to this change.

## Open Questions / Risks

- The `compileAgent` call is still synchronous and will block the event loop for the duration of compilation. This is acceptable per the task scope but could be wrapped in a worker thread in the future.

## Suggested Follow-ups

- Consider wrapping `compileAgent` in a worker thread or converting it to async internally (separate task, out of scope here).
- The pre-existing git config failures in agent sync tests should be addressed separately.
