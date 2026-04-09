---
title: "Staging clones use un-namespaced branches; missed by multi-tenancy rollout"
priority: high
reported-by: interactive-session
date: 2026-04-09
status: open
---

# Staging clones use un-namespaced branches; missed by multi-tenancy rollout

## Problem

The multi-tenancy rollout namespaced bare-repo branches under `docker/{project-id}/` (e.g. `docker/piste-perfect/agent-1`), but the pre-existing staging clones still have local branches using the old un-namespaced scheme (`docker/agent-1`, `docker/agent-2`, `docker/current-root`).

When `syncWorktree` fetches and checks out a branch for a build, the staging clone's local branch name does not match the namespaced branch in the bare repo. The clone ends up checked out on a stale branch or the wrong branch entirely.

## How it surfaced

Agent-2 on `piste-perfect` failed 42 out of 46 builds with the same error: `UBuildableComponentCostUtility.cpp` included `Data/BuildableComponentCost.h`, a header that had been renamed in a commit on the namespaced branch. The staging clone was stuck on its old un-namespaced `docker/agent-2` branch and never received the rename. The container agent could not fix the problem because the file existed only in the staging worktree — not in its git working tree.

Agent-1's staging clone was checked out on its local `docker/current-root` (un-namespaced) rather than tracking the bare repo's `docker/piste-perfect/agent-1`.

## Required behavior

- `syncWorktree` must fetch and check out the namespaced branch (`docker/{project-id}/{agent-name}`) from the bare repo, not rely on a pre-existing local branch name.
- When bootstrapping a new staging clone (see issue 041), the initial clone must use the namespaced branch.
- Existing staging clones with stale un-namespaced branches must be detected and corrected — either by renaming the local branch or by resetting to the namespaced branch from the bare repo.
