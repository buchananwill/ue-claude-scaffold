---
title: "Staging worktree retains deleted files after branch sync"
priority: high
reported-by: interactive-session
date: 2026-04-10
---

## Problem

When the staging worktree syncs to a new branch state that includes file deletions, the deleted files are not removed from the working directory. This causes UHT (Unreal Header Tool) to see both the old deleted file and its replacement, producing duplicate struct name errors that block the entire build.

## Observed Behaviour

Agent-2's branch deleted `SupplierAttributeFragment.h` and `.cpp` in commit `e1846bd2` (Phase 10), replacing their types with `ProductAttributes.h`. The branch history is clean — the files do not exist at HEAD.

However, the staging worktree at `D:\Coding\resort_game\staging\agent-2` still contains:

```
Source/PistePerfect/Public/EconomicSystem/SupplierFragments/ParallelOnSupplier/SupplierAttributeFragment.cpp
Source/PistePerfect/Public/EconomicSystem/SupplierFragments/ParallelOnSupplier/SupplierAttributeFragment.h
```

These show as **staged modifications** (not untracked), meaning the sync updated the branch ref but did not apply the deletion to the working tree. UHT then sees both files and reports:

```
SupplierAttributeFragment.h(16): Error: Struct 'FProductAttributeFragment' shares engine name
  with struct in ProductAttributes.h(15)
```

This produced 7 consecutive build failures (builds 2756-2764) before the conflict was somehow resolved. During those failures, the agent's actual code changes were never compiled — UHT aborted before reaching the compilation stage. The agent correctly diagnosed the error as "pre-existing" and signed off, meaning unverified code was merged.

## Impact

- **False build results**: The agent sees a build failure it didn't cause, concludes its own code is fine, and moves on. But its code was never actually compiled.
- **Wasted cycles**: 7 consecutive identical failures before resolution.
- **Silent correctness gap**: In this instance, the unverified code contained a `static_cast` that should have been `const_cast` and a private method access from a non-friend struct. Neither was caught because the compiler never ran on those translation units.

## Expected Behaviour

The staging worktree must be an exact mirror of what the agent sees in its container (excluding junction-linked plugins and engine source which are read-only). When the sync mechanism updates the branch ref, it must also ensure the working tree matches — deleted files must be deleted, new files must appear, modified files must reflect the branch content.

## Suggested Fix

The sync operation should use `git checkout --force` or `git reset --hard` to the target ref, ensuring the working tree is clean. Any approach that only updates the ref or does a merge without cleaning the working tree will leave ghost files. If there are concerns about build artefact directories, those should be in `.gitignore` and unaffected by a hard reset.
