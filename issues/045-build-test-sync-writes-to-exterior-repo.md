---
title: "Build/test staging sync silently writes to the exterior working directory when stagingWorktreeRoot is unset"
priority: critical
reported-by: interactive-session
date: 2026-04-08
status: open
---

# Build/test staging sync silently writes to the exterior working directory when stagingWorktreeRoot is unset

## Problem

`POST /build` and `POST /test` handlers call `syncWorktree` in `server/src/routes/build.ts`, which fetches the agent's branch from the bare repo and then runs `git checkout FETCH_HEAD -- <files>` plus `git update-ref refs/scaffold/last-sync FETCH_HEAD` against a worktree directory. The target directory is chosen by `getStagingWorktree` at `server/src/routes/build.ts:148-154`:

```ts
function getStagingWorktree(agentName: string | undefined, project: ProjectConfig): string {
  const worktreeRoot = project.stagingWorktreeRoot ?? config.server.stagingWorktreeRoot;
  if (worktreeRoot && agentName) {
    return path.join(worktreeRoot, agentName);
  }
  return project.path;
}
```

When `stagingWorktreeRoot` is not configured for the project and not configured at the server level, the fallback is `project.path` — which is the operator's exterior working directory, the one they edit in their IDE and use for interactive sessions. Every call to `/build` or `/test` from a container agent then:

1. Runs `git fetch <bareRepo> docker/<projectId>/<agent-name>` inside the operator's exterior repo.
2. Runs `git diff --name-only refs/scaffold/last-sync FETCH_HEAD` to compute changed files.
3. Runs `git checkout FETCH_HEAD -- <files>` which **writes those files to the operator's working directory and stages them in the operator's index**.
4. Runs `git update-ref refs/scaffold/last-sync FETCH_HEAD` which **writes to the operator's `.git` refs**.

The operator did not ask for any of this. The operator's stated workflow is one-way: the "Sync Bare Repo" button seeds the container workspace from the exterior repo, and container work comes back only via manual merge through the IDE's git tools. `syncWorktree`'s silent fallback to `project.path` bypasses that policy entirely.

## How it surfaced

On 2026-04-08, a container agent picked up Phase 1 of the schema hardening plan (task 216) and ran a build hook during its work. The operator later noticed three files staged in their IDE that they had not authored:

- `Notes/docker-claude/debriefs/debrief-0115-audit-scratch-line-fixes.md`
- `plans/schema-hardening-v25/audit-scratch.md`
- (plus at least one other file reported by the IDE as tracked-but-not-committed)

The operator's current branch (`staging/partial-decomp-container-run`) had no commit containing these files. `git log --all` found the commit (`63c7554`, authored by `Claude Code (Docker) <claude-docker@localhost>`) reachable only via `refs/scaffold/last-sync` — the bookkeeping ref that `syncWorktree` advances. The commit lives in the exterior repo's object database because the fetch pulled it in, but it is not on any branch the operator controls.

`curl http://localhost:9100/config/ue-claude-scaffold` confirmed `stagingWorktreeRoot: null` for the `ue-claude-scaffold` project, and `path` pointed at the operator's working directory. Cross-referencing with `server/src/routes/build.ts:148-154` made the fallback path explicit.

## Blast radius

Any project that does not set `stagingWorktreeRoot` (neither at the project level nor at the server level) is exposed. The `ue-claude-scaffold` project is currently in this state. Three behaviours follow:

- **Working-directory contamination.** Any file the agent wrote that differs from the operator's working tree is `git checkout`-ed into place, overwriting whatever the operator had in the working directory and index at those paths. The operator has no warning and no opt-out. If the operator was mid-edit on an overlapping file, their uncommitted work is silently destroyed.
- **Index pollution.** The operator sees staged changes they did not author. This looks like "tracked but not committed" in the IDE and is indistinguishable from normal staged work, but the files arrived via an automated checkout, not via the operator's own staging.
- **Ref pollution.** `refs/scaffold/last-sync` in the operator's `.git` advances to a commit the operator never asked to fetch. Subsequent `syncWorktree` calls use this ref as the base for their diff, so the first-run fallback cements itself — future syncs only catch up on new changes beyond what was already stomped.

The `stagingWorktreeRoot: null` fallback behavior is not documented anywhere. There is no warning log when the fallback triggers. There is no startup check. The operator discovers the contamination only by noticing files they did not write in their IDE.

## Required behavior

- `syncWorktree` must never operate on the exterior repo's working directory. If `stagingWorktreeRoot` is not configured at the project level or at the server level, `syncWorktree` must refuse to run and the calling `/build` or `/test` endpoint must return a structured error identifying the missing configuration. It must not fall back to `project.path`.
- The missing-configuration error must be surfaced to the operator with enough detail to act on it: project id, the config field that is unset, and the file (`scaffold.config.json`) that needs editing. The container's build-intercept hook must log the error prominently and post a message to the agent's channel so the operator sees it during interactive monitoring.
- Server startup must validate that every project in the resolved config has a `stagingWorktreeRoot` (directly or via the server-level default). Starting the server with any project missing this configuration must either fail loudly or log a critical warning. Silent acceptance of an unset staging root is not acceptable given the blast radius.
- `refs/scaffold/last-sync` must exist only inside staging worktrees, never inside the exterior repo's `.git`. The operator must be able to `git for-each-ref refs/scaffold` in their exterior repo and see nothing.
- The exterior repo's working directory and index must be modified only by the operator. No server-initiated process — build sync, test sync, plan sync, post-run cleanup, any future hook — may run `git checkout`, `git reset`, `git add`, `git rm`, `git update-ref`, or any other mutating command against the exterior repo. The only permitted server writes to the exterior repo are the ones the operator explicitly invokes via the dashboard or CLI (currently: the "Sync Bare Repo" button, which writes from exterior → bare, not bare → exterior).
- Existing staged changes introduced by prior fallbacks must be cleanable by a single operator action. The operator needs a way to identify which currently-staged files came from a `syncWorktree` fallback (via the commit's author, the `refs/scaffold/last-sync` pointer, or a dedicated audit log) so they can unstage and restore without manually triaging every file.
- The audit trail of affected projects must be discoverable: the operator should be able to query which projects in the current config have `stagingWorktreeRoot` unset, and which `refs/scaffold/*` refs exist in which repositories across their configured projects.

## Acceptance criteria

- Starting the coordination server with a project that has `stagingWorktreeRoot: null` either refuses to start or logs a critical-severity warning that names the project and the field. A silent startup is a regression.
- Calling `POST /build` or `POST /test` for an agent in a project with no `stagingWorktreeRoot` returns a clear structured error rather than executing the fetch/checkout sequence against the exterior repo. The build-intercept hook surfaces the error to the agent's log and to the operator's message channel.
- After the fix is in place, `git for-each-ref refs/scaffold` in the operator's `ue-claude-scaffold` exterior repo returns no refs.
- After the fix, launching a container for `ue-claude-scaffold`, triggering a build, and inspecting the operator's working directory shows zero changes that the operator did not author.
- A regression test in `server/src/routes/build.test.ts` (or a new `sync-worktree.test.ts`) constructs a `syncWorktree` call with an unset staging root and asserts that the function refuses to run and does not touch any directory that was not explicitly passed in as a staging worktree. The test must fail if a future refactor reintroduces the fallback.
- A migration note in `CLAUDE.md` or a setup guide documents the `stagingWorktreeRoot` configuration requirement and explains that projects without a staging worktree cannot run builds or tests.
- A recovery procedure documented in the issues folder or a note file explains how to clean up an exterior repo that has been contaminated by a prior fallback run, including the `refs/scaffold/last-sync` ref and any staged files sourced from container authors.

## Sequencing

Fix is not blocked by the schema-hardening plan currently in flight; the schema hardening does not touch `server/src/routes/build.ts` or the staging worktree resolution. However, because this bug is actively running in the operator's working directory every time an agent hits a build hook, it should land on a short-lived branch and merge ahead of the remaining schema-hardening phases. The operator's working directory is at risk for every agent build that happens in the meantime.

Until the fix lands, the operator's immediate workaround is to add `"stagingWorktreeRoot": "<some-absolute-path-outside-the-working-directory>"` to the `ue-claude-scaffold` entry in `scaffold.config.json`, create the directory, and restart the server. This is a configuration patch, not a code fix, and does not address the underlying silent fallback.

## Related

- Issue 041 (`041-staging-worktree-not-bootstrapped.md`) describes a nearby but distinct bug: `syncWorktree` does not create a missing staging worktree directory when one is configured. The two issues interact — fix 041 alone would not prevent the exterior-repo fallback, and fix 045 alone would not prevent the ENOENT failure mode described in 041. Both are in `syncWorktree` and a combined fix that refuses to run without a valid configured staging root, and bootstraps the staging root when it does not yet exist, would resolve both.
