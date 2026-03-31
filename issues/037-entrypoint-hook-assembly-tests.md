---
title: "No automated tests for entrypoint.sh hook assembly logic"
priority: low
reported-by: interactive-session
date: 2026-03-31
status: open
---

# Missing test coverage for dynamic hook settings assembly

## Problem

The hook assembly logic in `container/entrypoint.sh` (lines 72-118) dynamically constructs `/home/claude/.claude/settings.json` from `HOOK_BUILD_INTERCEPT` and `HOOK_CPP_LINT` env vars via jq. This logic has four distinct output shapes based on the two boolean flags, plus a deprecation shim with four cases of its own. None of these paths are tested.

The hooks directory has a precedent for testing (`lint-cpp-diff.test.py`), but no equivalent exists for the entrypoint logic.

## Suggested approach

Add a `container/test-hook-assembly.sh` script (using plain bash with `set -e` assertions or `bats`) that:

1. Sources or runs the settings-assembly section in isolation for each of the four flag combinations:
   - `buildIntercept=true, cppLint=true` → full hooks
   - `buildIntercept=true, cppLint=false` → build hooks only
   - `buildIntercept=false, cppLint=true` → lint only
   - `buildIntercept=false, cppLint=false` → agent-header only
2. Validates the generated JSON structure with `jq`
3. Tests the deprecation shim migration paths:
   - `DISABLE_BUILD_HOOKS=true` → both hooks off
   - `DISABLE_BUILD_HOOKS=false` → both hooks on
   - `DISABLE_BUILD_HOOKS=true` with explicit `HOOK_BUILD_INTERCEPT=true` → explicit wins
4. Tests the boolean validation rejects invalid values (exits non-zero for `HOOK_BUILD_INTERCEPT=yes`)

Requires jq to be available in the test environment (it's installed in the container Dockerfile).
