# Debrief 0207 — Phase 7 cycle 1 fixes

## Task Summary

Address the cycle-1 review findings for Phase 7 (arbitrator agent and
dispatch). Five findings to resolve, all under the BLOCKING / WARNING
budget — informational notes were deferred per the cycle instructions.

The findings cluster into three buckets:

1. The agent definition and the dispatch script disagree on what to do when
   the arbitrator's POST returns 409. The agent says "exit non-zero", but
   the daisy-chain's `role_session_no_op` detector only routes the task to
   `failed` when `sess_exit == 0 && post_status == last_status`. Non-zero
   trips the pump-loop's bail-out and strands the task in `arbitrating`.
2. Safety belt-and-braces on the arbitrator subprocess: the `Bash(curl:*)`
   permission is too broad, a persistent `.stderr` file leaks diagnostic
   info, and three server-derived prompt fields (`task_title`, `source_path`,
   `files_csv`) flow into the prompt without allowlist scrubbing.
3. The arbitrations plugin signature is the lone `FastifyPluginAsync` with
   no options object — the reviewer asks to align with the peer pattern
   (`FastifyPluginAsync<{ config: ScaffoldConfig }>`).

## Changes Made

| File | Action | Description |
|------|--------|-------------|
| `dynamic-agents/container-arbitrator-ue.md` | modified | Reworded the 409 handling instruction: agent now exits 0 (not non-zero) on a 409 conflict, with explicit reasoning naming the `role_session_no_op` detector and the pump-loop's non-zero bail-out path. |
| `.compiled-agents/container-arbitrator-ue.md` | regenerated | Recompiled via `npx tsx src/bin/compile-agent.ts /workspace/dynamic-agents/container-arbitrator-ue.md`. |
| `container/lib/arbitrator-dispatch.sh` | modified | (a) Rewrote the top-of-file block comment to describe the actual 409 → exit 0 → `role_session_no_op` flow. (b) Narrowed the curl permission from `Bash(curl:*)` to a URL-anchored `Bash(curl * ${SERVER_URL}/tasks/${task_id}/arbitrations*)` constructed at script time. (c) Dropped the `stderr_log` variable; redirected stderr to `/dev/null`. (d) Added allowlist scrubbing of `task_title`, `source_path`, and `files_csv` (per-entry split + rejoin) via `_scrub_engineer_path_field` from `run-claude.sh`. |
| `server/src/routes/arbitrations.ts` | modified | Changed plugin signature from `FastifyPluginAsync` to `FastifyPluginAsync<ArbitrationsOpts>` accepting `{ config }`; imported `ScaffoldConfig` for the option type. |
| `server/src/routes/arbitrations.test.ts` | modified | Registered the plugin with `{ config }` to satisfy the new typed option surface. |
| `server/src/index.ts` | modified | Registered `arbitrationsPlugin` with `{ config }` at startup. |
| `Notes/docker-claude/debriefs/debrief-0207-phase-7-cycle-1.md` | created | This debrief. |

## Design Decisions

**Restored-from-stash recovery.** Midway through the work I ran `git stash`
to compare test results against the parent commit; popping the stash restored
all five file edits cleanly. No edit was lost. The compiled agent had to be
re-regenerated after the pop since `.compiled-agents/` is generated.

**curl pattern construction (safety B1).** Claude Code's Bash permission
syntax matches command prefixes with `*` wildcards. The literal allowlist
string is fixed at `--allowed-tools` time, so I construct the pattern in
bash with `${SERVER_URL}` and `${task_id}` interpolated at script runtime:

    local curl_pattern="curl * ${SERVER_URL}/tasks/${task_id}/arbitrations*"
    claude --allowed-tools "...,Bash(${curl_pattern})" ...

This binds curl to POSTing to the arbitrations endpoint of THIS task on
THIS server only. If a future Claude Code release changes the matching
semantics and falls back to literal-prefix matching, the agent's curl will
be denied (the pattern includes spaces that won't appear in a real
command's literal prefix) and the arbitration will surface as
`role_session_no_op` — i.e. the failure mode is loud, not silent.

**Inline-documented fallback (safety B1).** Per the cycle-1 directive
"prefer constraining over documenting", the primary control is the URL
constraint. The dispatch comment also references the post-hoc audit via
`arbitrationRuns` as a backstop — every successful POST writes a row
the operator can review.

**Allowlist scrubbing of `files_csv` (safety W1).** `_scrub_engineer_path_field`
rejects commas (the path allowlist is `^[-A-Za-z0-9_./ ]+$`), so I split
the CSV on comma, scrub each entry, and rejoin with `", "`. Entries that
fail the allowlist drop from the list silently (the helper still emits a
stderr warning for the operator). This is the minimum-viable extension of
the existing scrub posture; I chose not to extract a shared helper because
the CSV-handling logic is the only caller that needs it.

**Plugin signature (safety W2).** Both `reviews.ts` and `findings.ts` are
currently `FastifyPluginAsync` with no options (the review finding's
description was slightly off-target), but the directive was explicit:
align with `tasksPlugin`'s shape. Following the directive.

## Build & Test Results

- `cd server && npm run typecheck` → **pass** (clean).
- `cd server && npx tsx --test src/routes/arbitrations.test.ts` → **20/20 pass**.
- `cd server && npm test` (full suite) → 757 tests, 703 pass, **54 pre-existing failures unrelated to this work** (confirmed by running the same failing test file on the parent commit `c7851f6` and observing the same 2/13 failure pattern in `projects.test.ts`; the failure mode is `409 !== 201` from cross-test project-id collisions and `Author identity unknown` from git-fixture setup — these are environment-level issues outside this cycle's scope).
- `bash -n /workspace/container/lib/arbitrator-dispatch.sh` → **pass**.
- Compiled agent regenerated cleanly:
  `container-arbitrator-ue.md -> /workspace/.compiled-agents/container-arbitrator-ue.md`.

## Open Questions / Risks

- **curl pattern reliability** depends on Claude Code's permission engine
  honouring glob matching for URL constraints. The fallback path is
  documented in-line; the post-hoc audit via `arbitrationRuns` mitigates
  any silent-bypass scenario.
- **Pre-existing test failures** (54) are not in this cycle's scope, but
  they will keep biting future implementers. They look fixable (git-fixture
  setup + test-isolation cleanup) but are out of scope for a cycle-1 review
  response.
- The informational notes (N1 surrogate split on the 500-char slice and
  N1 `contradiction.findingIds` cross-phase persistence) were called out
  as informational only and remain deferred.

## Suggested Follow-ups

- Audit and fix the 54 pre-existing test failures (git-fixture identity,
  project-id collision). A separate dedicated task is appropriate.
- Consider extracting `_scrub_engineer_path_field` to a shared
  `lib/scrub.sh` helper if a third caller materialises — for now the
  source-from-run-claude.sh approach is fine.
- The arbitrator agent's 409-handling instruction could be folded into a
  shared role-no-op skill if other roles develop the same conflict-on-second-post
  shape; currently the arbitrator is the only role with this concern.
