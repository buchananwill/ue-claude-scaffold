---
title: "Staging worktree's gitignored Content/ is never refreshed, so content-comparison tests fail there permanently"
priority: medium
reported-by: interactive-session
date: 2026-08-14
---

# Staging `Content/` is never refreshed, so content-comparison tests fail there permanently

The staging worktree syncs `Source/`, `Notes/`, `ContentSource/` from the bare repo, but binary
`Content/` is gitignored and has no refresh mechanism. Once the exterior repo's content pipeline
advances (new tables, manifest entries), staging's stale `Content/` diverges from its own
`ContentSource/`, and every test comparing live anchor assets against manifests fails in staging
while passing on the real worktree — currently 7–8 `Resort.ManifestAnchor.*` /
`CommandletImportManifest` failures, recorded as "residue" across piste-perfect debriefs 1431,
1432, 1435, 1438, and now chased (wastefully) by a fifth container until told to stop.

A permanently-red known-failure set in the container environment is corrosive: it re-trains agents
and reviewers to ignore failures, which is the exact habit the project's test protocol exists to
kill.

Suggested fixes, either sufficient:
1. After each staging sync, if `ContentSource/` changed, run the project's headless import
   commandlet (`-run=ContentCatalogue -Action=ImportManifest ... -PackageRoot=/Game/DataAssets`)
   against the staging uproject before any test run.
2. Cheaper: let projects declare a test-exclusion set for the staging environment
   (config per project), so environmental residue is subtracted from totals instead of reported as
   failures the agent must triage.

Operator workaround meanwhile: the host refreshes staging's Content manually in quiet windows
(no container build/test in flight, to avoid the two-editor log collision of issue 061).

## Resolved 2026-08-21 by the Git LFS cutover

Neither suggested fix was needed; the premise went away. `Content/` is no longer gitignored in
piste-perfect — commit `9a829534e` ("Track Content/ through Git LFS") tracks it, with
`*.uasset` / `*.umap` routed through LFS by `.gitattributes`. Staging therefore refreshes
`Content/` on every sync through the existing `git fetch` + `git reset --hard` in
`syncWorktree`, with no new mechanism.

Pipeline changes made at the same time:

- The bare repo now holds the LFS object store (6.2 GB) and is the sync source for staging.
  Staging worktrees set `lfs.storage` to that store, so all trees share one copy instead of
  duplicating it per tree.
- Containers install `git-lfs` with `--skip-smudge`, so `/workspace` gets 131-byte pointer
  files. Container clone size is unchanged; agents never see asset bytes and do not need to,
  since builds and tests are forwarded to a staging worktree on the host.

One-time consequence worth knowing about: while `Content/` was ignored, `git clean -fd` never
descended into it, so untracked assets accumulated in staging. Now that `Content/` is tracked,
clean does descend, and any asset not carried by the branch is removed on the next sync. The
pre-existing leftovers were moved to `staging/_quarantine-pre-lfs/` rather than deleted.
