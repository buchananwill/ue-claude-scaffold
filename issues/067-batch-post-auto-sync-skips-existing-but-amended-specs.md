---
title: "The batch POST's auto-sync fires only when sourcePath is MISSING on current-root, so an amended spec dispatches stale"
priority: high
reported-by: interactive-session
date: 2026-08-16
---

# The batch POST's auto-sync skips existing-but-amended specs

Task 228 (piste-perfect) was posted referencing a spec file that already existed on
`docker/piste-perfect/current-root` at an earlier draft. Because the auto-sync condition is "the file
is missing on current-root", no sync fired, and the subsequent `--fresh` launch seeded the agent from a
branch missing the spec's brief, six amended decisions, and a prior task's merged code. The container
claimed and began engineering against the stale contract before a manual `POST /sync/plans` could land;
recovery required stop → sync → fresh relaunch, and the FSM's own protections made the mid-state task
recoverable only by re-attachment (see issue 070).

The workaround now in use host-side: always `POST /sync/plans` explicitly before launching, and verify
the agent branch's seed against the exterior HEAD immediately after launch — a standing manual check
that the tooling should make unnecessary.

Suggested fixes, weakest to strongest:
1. Document the existence-only sync condition prominently in the dispatch flow.
2. Auto-sync on CONTENT HASH rather than existence: if the referenced sourcePath's blob differs between
   the exterior repo and current-root, sync.
3. Have launch.sh re-read current-root after any batch POST in the same dispatch sequence, or refuse
   `--fresh` when the exterior HEAD is ahead of current-root.
