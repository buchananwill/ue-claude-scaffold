---
title: "Container auto-commits create case-variant path collisions that corrupt case-insensitive worktrees"
priority: high
reported-by: interactive-session
date: 2026-06-21
---

## Summary

Docker container agents run on **case-sensitive Linux** and committed the same logical file under
**two casings** in two separate `Container auto-commit for build/test` commits:

- `35db3f676` introduced `Notes/ui/theme-integrated-visitor-styling-PLAN.md` (uppercase `PLAN`)
- `f6a6aa74c` introduced `Notes/ui/theme-integrated-visitor-styling-plan.md` (lowercase `plan`)

On Linux these are two distinct files, so both were tracked. When the branch is checked out on a
**case-insensitive Windows worktree** (NTFS, `core.ignorecase=true`), both index entries collapse
onto a **single physical file** — two index entries pointing different blobs at one inode.

## Impact (observed)

In the `piste-perfect` interactive worktree this manifested as undiagnosable, self-resurrecting
"uncommitted changes":

- `git status` compared the *lowercase* entry's blob to the single file on disk and always reported
  it modified.
- `git restore` / rollback satisfied one casing's entry while simultaneously dirtying the other's,
  so a clean tree was **unreachable** — every rollback made the change "reappear."
- Presented exactly like git corruption (`git fsck` was clean; it was not corruption).

Repair required surgically `git update-index --force-remove`-ing **both** exact-case entries,
deleting the single physical file, recreating it once under the chosen casing, and committing. A
normal user cannot be expected to diagnose or perform this.

This is data-integrity-adjacent: a container can silently make a branch un-checkout-cleanly on every
Windows/macOS worktree, and the symptom misdirects toward "git corruption."

## Root cause

Container-side commit flow has no guard against introducing a path that differs from an existing
tracked path **only by case**. Because the containers are the only Linux producers writing into
branches that are consumed on case-insensitive hosts, the guard belongs on the container commit path.

## Proposed fix

Add a pre-commit (or pre-push) check in the container commit flow that rejects case-variant
collisions before they enter history:

```bash
# Non-empty output = a case-only duplicate path exists in the index → abort the commit
git ls-files | sort -f | uniq -di
```

On a hit, the container should fail the auto-commit with an actionable message naming the colliding
paths, rather than committing. Optionally also normalize-on-write (the agent should not create a new
path that case-folds onto an existing tracked one).

## Suggested follow-ups

- One-time history scan across all project branches for existing case-collisions already merged, so
  other worktrees aren't sitting on latent copies of this bug.
- Consider documenting `git config core.protectNTFS` / case-handling expectations for mixed-OS
  worktree fleets.
