---
title: "Give each staging worktree its own Voxel Plugin copy to isolate UBT cache"
priority: high
reported-by: interactive-session
date: 2026-03-22
status: implemented
---

# Per-agent Voxel Plugin copy for build cache isolation

## Problem

All staging worktrees junction-link to the same Voxel Plugin directory on the host. The Voxel Plugin compiles a large volume of ISPC code (~360 seconds). When two agents alternate builds through the UBT lock, each agent's build can invalidate the other's cached Voxel intermediates — even when neither agent is modifying Voxel source. This forces a near-full Voxel recompilation on every build.

The result: builds that should take <20 seconds (when only project source changed) consistently take ~360 seconds because the Voxel ISPC code recompiles every time.

## Proposed fix

Give each staging worktree its own physical copy of the Voxel Plugin directory instead of a junction link to the shared host copy.

```
D:\Coding\resort_game\staging\agent-1\Plugins\Voxel\  ← own copy
D:\Coding\resort_game\staging\agent-2\Plugins\Voxel\  ← own copy
```

Each copy maintains its own `Intermediate/` directory, so UBT caches are fully isolated between agents. The ISPC code compiles once per agent on first build, then stays cached as long as the Voxel source doesn't change.

## Implementation

1. In `setup.sh` (or wherever staging worktree junctions are created), replace the Voxel junction with a full directory copy.
2. Same applies to any other large plugins that produce significant build artifacts (check UE5Coro, SubsystemBrowserPlugin — though these are likely much smaller).
3. Consider a script to refresh the copies when the upstream Voxel source changes (e.g. after a `git pull` on the Voxel repo).

## Cost

~500MB disk per staging worktree for the Voxel source + intermediates. Negligible compared to the electricity and API costs of 340 extra seconds per build across dozens of builds per run.

## Confirmed root cause (2026-03-22)

During a live run, agent-1 was repeatedly triggering no-change rebuilds (orchestrator review loop with no new commits). Each pointless UBT invocation wrote Voxel intermediate files via the shared junction, stomping agent-2's cached timestamps. Agent-2's subsequent builds then recompiled all Voxel ISPC code from scratch (~360 seconds) even though agent-2 had real changes that should have been a ~33 second incremental build.

A server-side fix (skip UBT when no source files changed) mitigated the immediate problem — agent-2's next build dropped to 33 seconds once agent-1 stopped thrashing the cache. But any time both agents have real changes and build in alternation, the shared junction will still cause mutual cache invalidation.

## Rollout plan

1. **Next run:** Hard-copy Voxel Plugin into each staging worktree. Verify build times stay <60 seconds for incremental builds with both agents active.
2. **If insufficient:** Also hard-copy UE5Coro and SubsystemBrowserPlugin. These are likely small enough that junction-linking is fine, but verify.

## Notes

The existing junction setup is documented in the memory file `project_staging_junctions.md`. The three gitignored plugin repos (Voxel, UE5Coro, SubsystemBrowserPlugin) all use junction links. Voxel is by far the most expensive to recompile; the others may be fine as junctions.
