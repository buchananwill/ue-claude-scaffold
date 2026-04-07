# Debrief 0076 — Phase 10: Exit Classifier

## Task Summary

Implement server-side abnormal exit classification (Steps 53-56). Port the regex-based exit detection heuristics from `entrypoint.sh` `_detect_abnormal_exit` into a TypeScript module, expose it as a route, and replace the shell function with a curl call to the server.

## Changes Made

- **server/src/exit-classifier.ts** — Created. Pure function `classifyExit()` with three detection stages: auth failure regex, token/rate limit regex, rapid exit heuristic (<10s and <5 lines). Faithful port of the bash grep patterns.
- **server/src/exit-classifier.test.ts** — Created. Unit tests covering auth failure (3 patterns), token exhaustion (6 patterns), rapid exit boundary conditions, clean exit, and priority ordering.
- **server/src/routes/exit-classify.ts** — Created. Fastify plugin with `POST /agents/:name/exit:classify` route. Validates body schema (logTail string, elapsedSeconds number, outputLineCount integer). Delegates to `classifyExit()`.
- **server/src/routes/exit-classify.test.ts** — Created. Integration tests for the route: auth failure, token exhaustion, rapid exit, clean exit, missing fields (400), negative elapsedSeconds (400).
- **server/src/routes/index.ts** — Modified. Added `exitClassifyPlugin` export.
- **server/src/index.ts** — Modified. Imported and registered `exitClassifyPlugin`.
- **container/entrypoint.sh** — Modified. Replaced inline grep-based `_detect_abnormal_exit` with a version that posts the last 200 lines of the log to the server's `/agents/:name/exit:classify` endpoint and reads the JSON response.

## Design Decisions

- The classifier is a pure function with no DB or side effects, following the same pattern as `hook-resolution.ts` / `hooks.ts`.
- The route is registered without config since it needs no config dependencies.
- The shell replacement uses python3 for JSON encoding (to safely handle arbitrary log content) and JSON response parsing, consistent with other parts of the codebase.
- Falls back to "not abnormal" if the server call fails, to avoid false positives from network issues.
- The `:name` param in the route path is accepted but not used for classification logic — it exists for consistency with the `/agents/:name/*` namespace and future per-agent logging.

## Build & Test Results

Pending initial build.

## Open Questions / Risks

- The entrypoint.sh replacement depends on python3 being available in the container. The container image already has python3.
- If the coordination server is unreachable during shutdown, the fallback is "not abnormal" which matches the previous behavior (grep would also fail if the file was missing).

## Suggested Follow-ups

- Consider adding the agent name to the classification result for logging/audit purposes.
- The route could optionally record the classification in the DB for post-mortem analysis.
