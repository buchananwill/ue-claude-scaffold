---
title: "Simplify architecture to a single bare repo with branches"
priority: medium
reported-by: interactive-session
date: 2026-03-19
---

# Simplify architecture to a single bare repo with branches

The current design uses multiple bare repos for agent isolation. This is unnecessary — a single bare repo with separate branches per agent achieves the same isolation without the overhead of syncing between repos.

## Current design

Multiple bare repos, one per agent (or per concern), with syncing logic between them.

## Proposed design

- **One bare repo** as the central hub
- Each container **clones from it** at startup (gets a full working copy)
- Each container **pushes to its own branch** when done
- Build/merge staging areas use **worktrees** off the same bare repo

This mirrors how GitHub works, just locally. Branches are just pointers to different commit trees — they don't conflict at the database level. Two agents can commit to different branches simultaneously without corrupting anything.

## Why this works

- Git branches are lightweight refs, not separate databases
- Concurrent pushes to *different* branches are safe
- Worktrees allow multiple branches to be checked out simultaneously from one `.git` database
- Eliminates the complexity of multi-repo synchronization

## Migration path

1. Consolidate to a single bare repo
2. Assign each agent its own branch namespace (e.g., `agent-1/work`, `agent-2/work`)
3. Replace inter-repo sync logic with standard `git push`/`git fetch` against the single repo
4. Use worktrees for any staging areas that need a checked-out working directory
