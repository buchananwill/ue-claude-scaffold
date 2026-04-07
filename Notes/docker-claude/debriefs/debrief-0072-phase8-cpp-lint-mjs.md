# Debrief 0072 -- Phase 8: Port cpp lint from Python to mjs

## Task Summary

Port `container/hooks/lint-cpp-diff.py` to `container/hooks/lint-cpp-diff.mjs`, producing character-for-character identical issue strings. Port all tests. Update references. Delete old Python files.

## Changes Made

- **container/hooks/lint-cpp-diff.mjs** -- Created. ESM port of all 8 lint rules from the Python version. Exports `checkLines()` for testability. Uses `#!/usr/bin/env node` shebang, native RegExp, reads stdin via `process.stdin`.
- **container/hooks/lint-cpp-diff.test.mjs** -- Created. 61 test cases ported from `lint-cpp-diff.test.py` using `node:test` and `node:assert/strict`. All 8 rules plus regression tests covered.
- **server/src/container-settings.ts** -- Modified. Renamed `pythonHook()` to `nodeHook()`, changed reference from `python3 lint-cpp-diff.py` to `node lint-cpp-diff.mjs`.
- **server/src/container-settings.test.ts** -- Modified. Updated assertions from `lint-cpp-diff.py` to `lint-cpp-diff.mjs`.
- **container/entrypoint.sh** -- Modified. Updated jq-generated hook commands from `python3 lint-cpp-diff.py` to `node lint-cpp-diff.mjs`.
- **container/hooks/lint-cpp-diff.py** -- Deleted.
- **container/hooks/lint-cpp-diff.test.py** -- Deleted.
- **container/hooks/lint-fuzz-test.py** -- Deleted.

## Design Decisions

- Used the `gs` flags on the IILE regex (Rule 8) to match Python's `re.DOTALL` behavior.
- For detecting whether the script is run directly vs imported, checked `process.argv[1]` for the filename rather than using `import.meta.url` comparison, since the script may be invoked from various paths.
- Output parity verified by running identical input through both Python and mjs versions and comparing output character-for-character.

## Build & Test Results

- `npm run build` in server/: SUCCESS (clean compile)
- `bash -n container/entrypoint.sh`: SUCCESS (valid syntax)
- `node --test container/hooks/lint-cpp-diff.test.mjs`: 61 passed, 0 failed
- `npx tsx --test src/container-settings.test.ts`: 12 passed, 0 failed
- Output parity test: identical output from Python and mjs on same input

## Open Questions / Risks

- The fuzz test (`lint-fuzz-test.py`) was deleted as instructed but had no mjs replacement. This is a host-side developer tool, not a container hook, so it is lower priority.

## Suggested Follow-ups

- Consider adding an mjs version of the fuzz test for running against real codebases.
- The `isMain` detection in the mjs file could be made more robust if needed (e.g., comparing `import.meta.url`).
