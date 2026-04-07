# Debrief 0067 -- Phase 7: Server-side Agent Compiler

## Task Summary

Port `scripts/compile-agent.py` to TypeScript as `server/src/agent-compiler.ts` with a CLI entry point at `server/src/bin/compile-agent.ts`. The TS compiler must produce byte-identical output for the same inputs. Update `launch.sh` to call the new TS compiler and delete the old Python script.

## Changes Made

- **server/src/agent-compiler.ts** (created): Line-for-line port of the Python agent compiler. Exports `parseFrontmatter`, `serializeFrontmatter`, `resolveSkill`, `compileAgent`, `findSubAgents`, and `SCOPE_RANK`. Uses `node:fs` and `node:path` only -- no external dependencies.

- **server/src/agent-compiler.test.ts** (created): 20 tests across 7 describe blocks covering frontmatter parsing (scalars, inline lists, multi-line lists, quoted strings, no frontmatter, comments), serialization (scalars, lists, quoting rules), round-trip identity, skill resolution (with and without ACCESS SCOPE markers), agent compilation (with skills, without skills), access scope ranking, and sub-agent discovery (matching, exclusion, partial name rejection).

- **server/src/bin/compile-agent.ts** (created): CLI entry point accepting the same flags as the Python version: positional `source`, `--all`, `-o/--output`, `--skills-dir`, `--recursive`, `--clean`. Same console output format and exit codes.

- **server/package.json** (modified): Added `"bin": { "compile-agent": "./dist/bin/compile-agent.js" }`.

- **launch.sh** (modified): Updated lines 452-465 to check for and invoke `server/dist/bin/compile-agent.js` instead of `scripts/compile-agent.py`.

- **scripts/compile-agent.py** (deleted): Removed the Python implementation.

## Design Decisions

- Used `process.stderr.write()` instead of `console.error()` to match the Python `print(file=sys.stderr)` behavior (no trailing newline surprises).
- The regex `\s*` in the frontmatter pattern consumes the blank line between `---` and body (same as Python), so the body starts without a leading newline when there is a blank separator line after frontmatter.
- `findSubAgents` uses `Map` iteration order (insertion order) with pre-sorted entries to match Python's `sorted(candidates.items())`.
- CLI argument parsing is hand-rolled (no external deps) to match the plan constraint.

## Build & Test Results

- **Build**: SUCCESS (`cd server && npm run build`)
- **Shell syntax**: SUCCESS (`bash -n launch.sh`)
- **Tests**: 20 passed, 0 failed (`npx tsx --test src/agent-compiler.test.ts`)

## Open Questions / Risks

- Byte-identical output depends on the frontmatter regex behavior matching between Python and Node.js. The `\s*` in `---\s*\n` consumes newlines in both engines, so the body offset is identical. Verified with a manual test.
- The `resolveSkill` function calls `process.exit(1)` on missing skills (matching Python behavior). This makes unit testing the error path harder -- the test suite does not currently test the missing-skill exit. A future refactor could throw instead.

## Suggested Follow-ups

- Add an integration test that compiles a real dynamic agent from the repo and compares output against a golden file.
- Consider making `resolveSkill` throw an error instead of calling `process.exit(1)` so callers can handle errors gracefully.
