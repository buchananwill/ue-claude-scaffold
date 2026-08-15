---
title: "/coalesce/pause does not prevent a paused pump claiming the next task the moment its predecessor integrates"
priority: medium
reported-by: interactive-session
date: 2026-08-16
---

# /coalesce/pause does not prevent the post-integration claim

Task 226 (piste-perfect) was queued under a pause-then-fresh-relaunch pattern precisely so it would
claim against a branch carrying a late spec amendment. The paused pump claimed it the moment task 225
integrated anyway, landing it on a branch missing the amendment. The gap was closed via the
correction-in-channel path, which then failed for its own reasons (the implementer never re-read the
channel after its opening read — recorded in the project's journal as its F45, whose standing rule is
now "a spec amendment that misses the branch seed gets the task re-seeded").

Suggested fixes:
1. Make pause actually gate claiming: a paused pump finishes its in-flight task and then claims nothing
   until resumed.
2. Alternatively, add a per-task `holdUntilSync` flag that blocks claiming until the task's sourcePath
   blob on the claiming branch matches the exterior repo's.
