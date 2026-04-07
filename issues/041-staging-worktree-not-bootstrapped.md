---
title: "Server never bootstraps a missing staging worktree; misleading ENOENT"
priority: high
reported-by: interactive-session
date: 2026-04-07
status: open
---

# Server never bootstraps a missing staging worktree; misleading ENOENT

## Problem

`syncWorktree` in `server/src/routes/build.ts` calls `runCommand('git', ['fetch', bareRepo, branch], worktreePath, ...)` against a `worktreePath` computed by `getStagingWorktree`. **Nothing in the codebase ever creates that directory.** A grep across `server/src/` for `mkdir.*worktree` or `git.*clone.*worktree` returns zero matches. The server expects the worktree to already exist on disk.

For agents whose names happen to match a manually-created directory under `stagingWorktreeRoot`, the build hook works. For any new agent name, the first build hook call fails immediately with:

```
syncWorktree: git fetch failed: spawn git ENOENT
```

The `cwd` passed to `spawn` does not exist, and Node reports the failure as `spawn ${command} ENOENT` regardless of which path was missing — the executable or the working directory. The error message blames git, but git is fine.

## How it surfaced

A pump-mode launch against `piste-perfect` with a fresh agent name `worker-pp-1` triggered the failure. The `D:\Coding\resort_game\staging\` directory contained `agent-1`, `agent-2`, and `cleanup-leader` from prior manual setup, but no `worker-pp-1`. The build hook failed on the first sync. Reusing one of the existing agent names produces a working build hook, which confirms the diagnosis.

## Why it looks like a multi-tenancy regression but isn't

The bug has been latent in `syncWorktree` since it was first written. It only triggers when `getStagingWorktree` returns a directory that has never been bootstrapped. Every previously-successful build run on this machine happened to use an agent name that matched a hand-created worktree directory from initial project setup. The multi-tenancy migration changed branch naming and added project scoping, but did not introduce or modify the worktree-creation gap — there was no worktree-creation code before, and there is none now.

## Fix

Add an `ensureWorktree` step to `syncWorktree` that detects a missing or non-git worktree directory and bootstraps it before the first git command:

1. If `worktreePath` exists and contains `.git`, return immediately.
2. Otherwise, `mkdir -p` the parent directory.
3. `git clone --shared --branch <branch> <bareRepo> <worktreePath>` from the parent directory as cwd. `--shared` keeps object storage in the bare repo so each per-agent worktree only stores its working files and refs locally.
4. On clone failure, throw a clear error naming the bare repo, the branch, and the target path.

Call `ensureWorktree` at the top of `syncWorktree`, before the existing `git fetch` block. The fetch logic that follows is unchanged — it operates on a worktree that is now guaranteed to exist.

## Side improvement: disambiguate ENOENT in `runCommand`

The current `runCommand` error handler in `server/src/routes/build.ts` returns `err.message` verbatim from the spawn error event, which produces `spawn git ENOENT` for both "git binary missing" and "cwd directory missing". Wrap this so the handler checks `existsSync(cwd)` on ENOENT and returns one of:

- `cwd does not exist: <path>` when the cwd is missing
- `executable not found: <command>` when the executable is missing

This single change would have eliminated a multi-step wrong-diagnosis loop today.

## Sequencing

Resolve **after** the shell-script-decomposition-and-python-consolidation plan lands. That plan's Phase 11 (decompose `launch.sh` and replace docker-compose heredoc) and Phase 3 (server branch operations) both touch the surrounding code in `server/src/routes/build.ts` and `server/src/branch-ops.ts`. Doing the worktree-bootstrap fix in parallel would create merge conflicts. After the plan commits, this fix is a small additive function plus one call site plus a unit test.

## Acceptance criteria

- Launching a piste-perfect (or any project) agent with an agent name that has never been used creates the staging worktree on first build hook call and the build runs to completion.
- Re-launching the same agent name finds the existing worktree and reuses it.
- A `runCommand` ENOENT against a missing cwd reports `cwd does not exist: <path>`, not `spawn git ENOENT`.
- A `runCommand` ENOENT against a missing executable reports `executable not found: <command>`.
- A unit test in `server/src/routes/build.test.ts` (or a new `worktree-bootstrap.test.ts`) creates a temporary bare repo, calls `syncWorktree` with a missing target directory, and asserts that the directory exists and contains a valid git repo afterward.
