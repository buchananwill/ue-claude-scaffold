# Test Hook Flag Passthrough

## Goal
Fix the container test hook to pass through command-line flags (like `--with_rhi`) to the host-side test script, instead of stripping them.

## Context
The hook currently filters out all arguments starting with `--` when extracting test filters (line 88 of `container/hooks/intercept_build_test.sh`). This was likely to separate positional test names from options, but it completely discards the options. The server's `/test` endpoint only accepts a `filters` array and passes those as script arguments, so there's no way to forward flags currently.

The test script (`Scripts/run_tests.py` by default) expects flags first, then test names: `run_tests.py --with_rhi TestName`.

<!-- PHASE-BOUNDARY -->

## Phase 1: Update hook to capture flags separately

**Outcome:** The hook parses the test command into two separate lists: flags (arguments starting with `--`) and filters (positional test names), and sends both to the server in the request body.

**Types / APIs:**
```typescript
// Request body to /test endpoint (new shape)
{
  filters?: string[];      // Test names/patterns
  flags?: string[];        // Command-line flags like --with_rhi
}
```

**Work:**
- Rewrite the filter extraction logic in `container/hooks/intercept_build_test.sh` (lines 85–99) to:
  - Extract everything after the test script name
  - Split into individual arguments
  - Separate flags (start with `--`) from positional test names
  - Build two lists: `FLAGS` and `FILTERS`
- Update the JSON payload construction to include both arrays:
  ```bash
  REQUEST_BODY=$(jq -n --argjson flags "$FLAGS_ARRAY" --argjson filters "$FILTERS_ARRAY" \
    '{flags: $flags, filters: $filters}')
  ```
  where `FLAGS_ARRAY` and `FILTERS_ARRAY` are JSON arrays built from the shell arrays

**Verification:**
- Manually test with a command like `./container/hooks/intercept_build_test.sh <<< '{"tool_input":{"command":"run_tests.py --with_rhi MyTest"}}'`
- Verify the REQUEST_BODY contains both `flags: ["--with_rhi"]` and `filters: ["MyTest"]`

<!-- PHASE-BOUNDARY -->

## Phase 2: Update server /test endpoint to accept and use flags

**Outcome:** The `/test` endpoint accepts a `flags` array in the request body, merges it with filters, and passes both to the test script in order: flags first, then filters.

**Types / APIs:**
```typescript
// POST /test request body
{
  filters?: string[];
  flags?: string[];      // NEW: command-line flags
}
```

**Work:**
- Update the request type in `server/src/routes/build.ts` line 423–424 to include `flags?: string[]`
- Modify the `/test` handler (lines 425–462):
  - Extract both `flags` and `filters` from `request.body`
  - Build `scriptArgs` as: `[...flags, ...filters]` (flags first, then test names)
  - Pass `scriptArgs` to `resolveScript(scriptPath, scriptArgs)`
- Ensure empty or undefined flags/filters arrays are handled gracefully (pass empty array, which is already safe in the spread operator)

**Verification:**
- Unit test: POST `/test` with body `{flags: ["--with_rhi"], filters: ["MyTest"]}` and verify the spawned command includes both arguments in order
- Existing tests should still pass (filters-only requests have `flags: undefined` or `[]`, which spreads to nothing)

