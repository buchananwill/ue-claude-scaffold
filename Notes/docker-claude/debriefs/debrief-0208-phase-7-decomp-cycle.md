# Debrief 0208 — Phase 7 decomposition pass

## Task Summary

The terminal decomposition review of Phase 7 raised 2 WARNING (W1, W2) and 3 NOTE (N1, N2, N3) findings. N2 was informational only. Address W1, W2, N1, and N3 in a single cleanup commit. Both files in scope (`reviews.ts`, `reviewer-fanout.sh`) were authored in this task's commit lineage and are eligible for revision.

## Changes Made

### W1 — extract unique-constraint conflict helper

- **`server/src/routes/_route-helpers.ts`** — added `isUniqueConstraintConflict(err, constraintName)` exported helper that generalises the recursive-cause unique-violation detector used by both `arbitrations.ts` and `reviews.ts`. Same shape, same defensive constraint-name fallback in the message-text branch (no blanket 23505 catch-all).
- **`server/src/routes/arbitrations.ts`** — dropped the local `isUniqueArbitrationConflict` (17 lines, identical apart from the constraint name); imports `isUniqueConstraintConflict` and passes `'arbitration_runs_task_trigger_unique'`.
- **`server/src/routes/reviews.ts`** — dropped the local `isUniqueRunConflict`; imports `isUniqueConstraintConflict` and passes `'review_runs_task_cycle_role_unique'`.

### W2 + N1 — rename + extend prompt-string scrub

- **`container/lib/run-claude.sh`** — renamed `_scrub_engineer_path_field` → `_scrub_prompt_path_field` since the helper now has three call sites (engineer, arbitrator, reviewer-fanout). The warning string drops `_build_engineer_prompt` and now reads `WARNING: rejecting non-allowlisted ${label}; ${suffix}` (the per-call `${label}` continues to identify the field).
- **`container/lib/run-claude.sh`** — added `_scrub_prompt_path_csv` which encapsulates the split-scrub-rejoin loop previously inlined in `arbitrator-dispatch.sh`. Same `IFS=,` split, same trim, same drop-on-reject semantics.
- **`container/lib/run-claude.sh`** — engineer dispatch (`_fetch_engineer_fsm_fields`) updated to call the renamed helper for the three path fields (source_path, latest_review_path, addendum_path).
- **`container/lib/arbitrator-dispatch.sh`** — replaces the inline 20-line CSV split with a single `_scrub_prompt_path_csv` call; renames the two single-field calls to `_scrub_prompt_path_field`. Net reduction: 18 lines.
- **`container/lib/reviewer-fanout.sh`** — new scrub block immediately after the four `jq` field extracts. Scrubs `task_title`, `source_path` via `_scrub_prompt_path_field`; scrubs `files_csv` via `_scrub_prompt_path_csv`. The same triple that the arbitrator dispatch was already scrubbing.

### N3 — drop unused `ArbitrationsOpts`

Verified the peer ingestion routes (`reviews.ts`, `findings.ts`, `failures.ts`) all register without an options object. Only `arbitrations.ts` was the odd one out, carrying a typed-but-unused `{ config }`. Dropped:

- **`server/src/routes/arbitrations.ts`** — removed the `ArbitrationsOpts` interface and the `ScaffoldConfig` import; the plugin declaration now reads `FastifyPluginAsync` (no generic). The block-comment explanation of the cycle-1 safety-reviewer rationale is replaced with a cycle-2 note explaining why the wrapper was dropped to match peer routes.
- **`server/src/index.ts`** — registration changes from `register(arbitrationsPlugin, { config })` to `register(arbitrationsPlugin)`.
- **`server/src/routes/arbitrations.test.ts`** — test registration matches (no `{ config }`).

## Design Decisions

- **Where to put the prompt-scrub helpers.** The decomp reviewer suggested either `run-claude.sh` (next to the existing engineer helper) or a new `container/lib/prompt-scrub.sh`. Chose `run-claude.sh` because both new callers (`arbitrator-dispatch.sh`, `reviewer-fanout.sh`) are already sourced after `run-claude.sh`, so no source-order touchpoints change. A new file would force `entrypoint.sh` and any future callers to re-establish source order.
- **N3 direction.** Inspected every peer ingestion route. Three of the four (`reviews`, `findings`, `failures`) register without options; only `arbitrations` was the outlier from cycle 1. Per the decomp reviewer's escape clause ("if `arbitrations.ts` ends up the odd one out either way, prefer dropping"), dropped the wrapper. The cycle-1 safety reviewer's claim that opts were the established convention was incorrect — the convention varies per route family, and the ingestion family is opts-less.
- **N1 warning string.** Stripped the `_build_engineer_prompt` reference rather than picking a generic label. The per-call `${label}` parameter (e.g. `source_path`, `task_title`, `files_csv[entry]`) is more informative than a generic caller name, so the warning still identifies the field cleanly.

## Build & Test Results

- `cd server && npm run typecheck` — clean.
- `cd server && npx tsx --test src/routes/arbitrations.test.ts src/routes/reviews.test.ts src/routes/findings.test.ts src/routes/failures.test.ts` — **80 / 80 pass**. All four directly-affected suites green.
- `cd server && npm test` (full suite) — `tests 757`, `pass 703`, `fail 54`. The 54 failures fall into four unrelated top-level suites (`POST /agents/:name/sync`, `projects routes`, `tasks with bare repo and agents`, `tasks routes`) and stem from the test environment missing `git config user.email` (100 instances of `fatal: unable to auto-detect email address` in the log). Confirmed by grep that none of the failing subtests touch `arbitrations`, `reviews`, `findings`, `failures`, or the dispatch scripts. These failures are pre-existing on the agent branch and not regressions from this commit.
- `bash -n` on `run-claude.sh`, `arbitrator-dispatch.sh`, `reviewer-fanout.sh` — all clean.

## Open Questions / Risks

- The reviewer-fanout scrub is a new safety control that did not exist in the original Phase 6 implementation. Test fixtures in `reviews.test.ts` use simple titles (`arb-task`, etc.) and path-shaped sourcePath values, so they survive the allowlist. If any future fixture introduces a colon, paren, or other non-allowlist character in `task_title` / `sourcePath` / `files`, the value will collapse to empty in the per-reviewer prompt header. This is the desired safety posture (matching arbitrator) but worth flagging since the reviewer prompts now have a stricter input than the engineer prompt for `task_title` (the engineer scrub never touched `title`; the arbitrator and reviewer-fanout both scrub it).

## Suggested Follow-ups

- The engineer dispatch never scrubs `title` (`_build_engineer_prompt` reads `title=$(... | tr -d '\n')` and uses it raw in the header). For consistency with arbitrator and reviewer-fanout, a future cleanup could apply `_scrub_prompt_path_field` to engineer `title` too. Out of scope for this cycle — the decomp finding was about parity *between* the two new dispatchers, not extension to the engineer path. Flagged here only.
- The pre-existing test failures (missing `git config user.email`) are an environmental issue worth investigating — separate cleanup task.

---

## Cycle 4 addendum — comment cleanup

Follow-up correctness WARNING + two safety NOTEs all pointed at stale comments left over from the decomposition pass. Comment-only changes; no code paths altered.

### Changes

- **`container/lib/reviewer-fanout.sh`** — rewrote the `SECURITY:` block above `_rfan_build_reviewer_prompt` to describe the actual two-layer posture. Layer 1 is the caller `_run_reviewer_fanout` allowlist-scrubbing `task_title`, `source_path`, and `files_csv` via `_scrub_prompt_path_field` / `_scrub_prompt_path_csv` BEFORE the prompt builder runs (added in cycle 2 / decomp pass, commit `db18016`). Layer 2 is the existing `printf %s` + non-expanding heredoc defence at this site. The old comment claimed the values were "NOT sanitized" which is no longer true.
- **`container/lib/run-claude.sh:70`** — block comment above `_scrub_prompt_path_field` no longer names the old `_scrub_engineer_path_field` symbol; reads "renamed from the original engineer-only helper" instead. The rename context is preserved without leaving the dangling identifier in the source.
- **`container/lib/run-claude.sh:147`** — docstring inside `_fetch_engineer_fsm_fields` updated to reference `_scrub_prompt_path_field` (the actual function it calls).

### Verification

- `bash -n container/lib/reviewer-fanout.sh container/lib/run-claude.sh` — clean.
- `git grep -n _scrub_engineer_path_field` returns hits only in `Notes/docker-claude/debriefs/debrief-0204-*.md`, `debrief-0207-*.md`, and `debrief-0208-*.md` (this file). These are immutable point-in-time audit records that correctly reference the helper's name as it existed at the time of writing; rewriting them would falsify the historical record. No code or active prose references the old name.
- Server tests skipped per the cycle-4 instruction (no server changes).
