---
title: "Batch auto-sync gates on file-missing, not freshness — re-dispatched plans run their stale text"
priority: high
reported-by: interactive-session
date: 2026-08-13
---

# Batch auto-sync gates on file-missing, not freshness — re-dispatched plans run their stale text

## Incident (piste-perfect, task 218, 2026-08-13)

Task 218 referenced a plan file that had existed on `docker/piste-perfect/current-root` since an
earlier task's sync, but had since been substantially amended in the exterior repo (Implementer's
Brief, four decision amendments) — and the codebase itself had advanced by a full merged feature
arc. Because `/tasks/batch` auto-syncs **only when the `sourcePath` is missing** on current-root,
no sync fired; `--fresh` then reset the agent onto the stale root. The container ran a full,
review-approved FSM cycle — implementing the spec's first draft against a codebase state that no
longer exists, migrating files the interim arc had deleted and missing files it had added. The
entire run was unusable; detected only at host-side merge via a modify/delete conflict on a file
HEAD had deleted.

## Defect

Auto-sync's trigger conflates "the plan is present" with "the plan is current". Presence is the
wrong predicate for a re-dispatch: an amended plan re-dispatched under the same path silently runs
its old text, and the agent additionally inherits an arbitrarily stale codebase.

## Suggested fixes (any one suffices; first is strongest)

1. Auto-sync unconditionally once per batch (the sync is cheap relative to a wasted container run).
2. Compare the exterior repo's HEAD against current-root and sync when they diverge.
3. At minimum: `--fresh` launches warn (or refuse without a flag) when the exterior repo's HEAD is
   ahead of current-root.

## Operator workaround (documented in the project journal)

Always `POST /sync/plans` explicitly before dispatching any plan whose `sourcePath` already exists
on current-root.
