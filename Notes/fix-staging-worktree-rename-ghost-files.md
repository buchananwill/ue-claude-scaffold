# Fix staging worktree ghost files from rename-detected deletes

## Goal

Stop `syncWorktree` in `server/src/routes/build.ts` from leaving ghost files in the staging worktree when git detects a
delete+add pair as a rename. Repair agent-2's currently stuck `D:\Coding\resort_game\staging\agent-2` worktree. Close
issue 047.

## Context

`syncWorktree` computes two diffs between `refs/scaffold/last-sync` and `FETCH_HEAD`: one with `--diff-filter=D` for
deletes, one with `--diff-filter=AMCR` for adds/modifies/copies/renames. It then runs `git rm` on the delete list and
`git checkout FETCH_HEAD -- ...` on the add/modify list.

Git's diff machinery enables rename detection by default. When a file is deleted in one commit and a similar-content
file appears with a new name (piste-perfect commit `e1846bd2` — `SupplierAttributeFragment.h/cpp` removed,
`ProductAttributes.h` added), git classifies the pair as `R` rather than `D` + `A`:

- The `D` filter returns empty for the old path — `git rm` is never called.
- The `AMCR` filter with `--name-only` returns only the rename *target* — the old path is invisible.

Result: the old file sits in the staging worktree's index and working tree forever, UHT sees two structs with the same
engine name, build fails with a false negative. The agent's real code never compiles, the agent concludes its code is
clean, and unverified code merges. Issue 047 documents the symptom; builds 2756–2764 on piste-perfect were all this bug.

Fix: pass `--no-renames` so deletes and adds are reported independently. Two additional hardening items land in the same
edit because we're already touching this code path: a fallback when `git rm` fails (mirroring the existing
`git checkout` fallback), and a regression test that commits a rename-detectable change and asserts the old path is
gone.

The existing `build.test.ts` exercises routing and the UBT-contention regex but never sets up real commits on the bare
repo or inspects the staging worktree after a sync. The regression test needs to be the first one that does.

Out of scope: rewriting `syncWorktree` to use `git reset --hard` unconditionally. The current design deliberately keeps
HEAD pinned so that `git checkout FETCH_HEAD -- <files>` shows as staged changes and triggers UBT's "working set
changed" makefile invalidation (see commit `de6be8e`). That invariant is preserved.

## Phase 1 — Pass `--no-renames` to the sync diffs and harden the delete path

**Outcome:** `syncWorktree` in `server/src/routes/build.ts` computes its delete list and add/modify list with rename
detection disabled, so a rename-detected deletion is reported as a plain delete. If `git rm` on the delete list fails,
the function falls back to `git reset --hard FETCH_HEAD` instead of silently continuing. `npm run typecheck` passes.

**Types / APIs:** No type or signature changes. `syncWorktree` keeps its existing signature:

```ts
async function syncWorktree(
    agentName: string | undefined,
    projectId: string,
    project: ProjectConfig,
): Promise<"changed" | "unchanged">
```

**Work:**

- Edit `server/src/routes/build.ts` around lines 223–235. Add `--no-renames` to both `git diff` invocations:
    - `git diff --name-only --no-renames --diff-filter=D baseRef FETCH_HEAD`
    - `git diff --name-only --no-renames --diff-filter=AMCR baseRef FETCH_HEAD` (`C` and `R` become dead letters with
      `--no-renames` but leaving them is harmless and keeps the diff inert)
- In the delete branch (lines 261–268), capture the `git rm` result. If `!rmResult.success`, run the same
  `git reset --hard FETCH_HEAD` fallback the checkout branch already uses (lines 278–290), including `updateSyncRef` and
  returning `"changed"`.
- No changes to the checkout branch, the fallback helper, or `updateSyncRef`.
- Run `npm run typecheck` in `server/` and fix any type errors.

**Verification:**

- `cd server && npm run typecheck` → exits 0.
- `cd server && npx tsx --test src/routes/build.test.ts` → existing tests still pass (no regressions in
  routing/validation behaviour).

## Phase 2 — Regression test for rename-detected delete

**Outcome:** A new test in `server/src/routes/build.test.ts` sets up a bare repo + staging worktree, commits file A,
syncs, commits (delete A + add B with similar content to trigger git's rename detector), syncs again, and asserts file A
no longer exists on disk in the staging worktree. The test fails on `main` and passes after Phase 1.
`cd server && npm test` is green.

**Types / APIs:** No production type changes. Test helpers are local to the test file unless an existing helper
obviously fits.

**Work:**

- Add a new `describe('build route staging worktree sync', ...)` block to `server/src/routes/build.test.ts`.
- `beforeEach`: create tmpDir, initialize a bare repo at `tmpDir/bare.git`, create `tmpDir/seed` as a working clone,
  make an initial commit on `docker/default/current-root` containing a file whose content is close enough to the file
  that will replace it for git to score the change as a rename (e.g. a 60-line header; copy ~50 lines verbatim into the
  replacement file in the later commit). Push to the bare repo. Initialize `tmpDir/staging/test-agent` as a git repo
  with a matching initial commit fetched from the bare repo so the staging worktree starts in a coherent state. Register
  `test-agent` via `POST /agents/register` with `worktree: 'docker/default/test-agent'` and push a branch of that name
  to the bare repo pointing at the initial commit. Configure the test app with `stagingWorktreeRoot: tmpDir/staging` and
  `bareRepoPath: tmpDir/bare.git`.
- Test body:
    - `POST /build` with `x-agent-name: test-agent` and `x-project-id: default`. Assert 200. This is the first sync and
      establishes `refs/scaffold/last-sync`.
    - In the working clone, delete the original file, add the replacement file with majority-overlapping content,
      commit, push to `docker/default/test-agent` in the bare repo.
    - `POST /build` again with the same headers. Assert 200.
    - Assert via `fs.existsSync` that the original file path under `tmpDir/staging/test-agent` is **false**.
    - Assert via `fs.existsSync` that the replacement file path is **true**.
- `afterEach`: `rmSync(tmpDir, { recursive: true, force: true })` wrapped in try/catch like the existing blocks.
- Do not assert on the build mock script output — this test is about sync behaviour, not build invocation. The existing
  mock script exits 0, which is fine.

**Verification:**

- On a branch without the Phase 1 fix, `cd server && npx tsx --test src/routes/build.test.ts` → the new test fails with
  the ghost file still present on disk.
- With the Phase 1 fix applied, `cd server && npx tsx --test src/routes/build.test.ts` → all tests pass.
- `cd server && npm test` → entire suite green.

## Phase 3 — Unstick the live piste-perfect/agent-2 staging worktree

**Outcome:** `D:\Coding\resort_game\staging\agent-2` exactly matches the tip of `docker/piste-perfect/agent-2` in the
piste-perfect bare repo. `SupplierAttributeFragment.h` and `SupplierAttributeFragment.cpp` no longer exist anywhere
under that path. `refs/scaffold/last-sync` in that worktree points at the same commit as the branch tip, so the next
`/build` sync computes an empty diff.

**Types / APIs:** N/A — one-time operator action against a live worktree.

**Work:**

- Identify the piste-perfect bare repo path (from `scaffold.config.json` → `projects.piste-perfect.bareRepoPath`, or
  whichever key piste-perfect is registered under).
- In `D:\Coding\resort_game\staging\agent-2`, run the following sequence in Git Bash:
  ```
  cd "D:/Coding/resort_game/staging/agent-2"
  git fetch <piste-perfect-bare-repo-path> docker/piste-perfect/agent-2
  git reset --hard FETCH_HEAD
  git update-ref refs/scaffold/last-sync FETCH_HEAD
  ```
- Confirm the ghost files are gone:
  ```
  ls Source/PistePerfect/Public/EconomicSystem/SupplierFragments/ParallelOnSupplier/SupplierAttributeFragment.h
  ls Source/PistePerfect/Public/EconomicSystem/SupplierFragments/ParallelOnSupplier/SupplierAttributeFragment.cpp
  ```
  Both should report "No such file or directory".
- Confirm `git status` is clean.
- This phase is operator-executed — discuss timing with the user before running it. Do not run it from an autonomous
  session without confirmation.

**Verification:**

- `git status` in the staging worktree reports nothing to commit, working tree clean.
- `git rev-parse HEAD` equals `git rev-parse refs/scaffold/last-sync` equals the bare repo's
  `docker/piste-perfect/agent-2` tip.
- Kick a build from an agent-2 container (or `POST /build` with `x-agent-name: agent-2`, `x-project-id: piste-perfect`
  directly). The sync should be a no-op (both diffs empty, returns `"unchanged"`), and UHT should no longer see the
  duplicate struct.

## Phase 4 — Close out issue 047

**Outcome:** `issues/047-staging-worktree-ghost-files.md` is deleted from the repo. `git log` carries the fix commits as
the audit trail.

**Types / APIs:** N/A.

**Work:**

- `git rm issues/047-staging-worktree-ghost-files.md`
- Commit the deletion alongside or after the code changes from Phases 1 and 2 — engineer's call on whether to bundle or
  separate.

**Verification:**

- `ls issues/047-staging-worktree-ghost-files.md` → file not found.
- `git log --oneline issues/047-staging-worktree-ghost-files.md` shows the deletion commit at the top.
