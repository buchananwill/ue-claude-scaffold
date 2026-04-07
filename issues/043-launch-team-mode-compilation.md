---
title: "Team launches fail because dynamic-agent compilation does not reach team member types"
priority: high
reported-by: interactive-session
date: 2026-04-07
status: open
---

# Team launches fail because dynamic-agent compilation does not reach team member types

## Problem

A `./launch.sh --team <id>` invocation completes the launch script but produces containers that crash at startup within seconds. Every team member container fails with `ERROR: Agent type '<name>' not found in snapshotted agents` from `entrypoint.sh`.

## Root cause

`launch.sh` compiles dynamic agents by invoking `compile-agent.py` once with the resolved `AGENT_TYPE` (which for a team launch is the project's default agent type, not any team member's type) and the `--recursive` flag. `compile-agent.py --recursive` scans the lead agent's compiled skill bodies for references to other dynamic agents and compiles those transitively.

For team launches this is structurally insufficient:

1. Team member agent types (`design-leader`, `design-architect`, `design-domain`, `design-ui`, `changeling`, `cleanup-leader`, and so on) are not semantically reachable from any project's default agent. The orchestrators delegate to implementers and reviewers, never to design roles. No recursive scan from a lead agent will ever reach a design team member.
2. The team launch path passes the same `AGENTS_PATH` (pointing at `.compiled-agents/`) to every team member's container. There is no per-member compilation pass.
3. When a team member container starts, it looks for its agent file in the snapshotted agents directory and does not find it, because `compile-agent.py` was never asked to produce it.

## Why this now fails where the previous static-agent model worked

Before the dynamic-agent migration, `launch.sh` copied agent markdown files wholesale into the staged-agents directory without compilation. Every team member's agent file was present regardless of which agent was nominally "the lead". The dynamic-agent migration replaced that copy with a recursive compile of a single lead agent, which is sound for orchestrator + sub-agent chains (all reachable from the lead's skills) but does not reach the design team member types declared in `teams/*.json`.

The eleven design-team agents are now available as dynamic agents under `dynamic-agents/` (added adjacent to this issue) but remain unreachable from any single lead agent's recursive scan. Their presence in `dynamic-agents/` is a precondition for a fix; it is not itself a fix.

## Required behavior

- A `./launch.sh --project <id> --team <team-id> --brief <path>` invocation must launch every team member container in a state where that member's agent definition is present in the container's snapshotted agents directory.
- The set of agent definitions made available to the team must be exactly the set of `agentType` values declared in `teams/<team-id>.json`, each carrying its correct access-scope metadata.
- A team definition that references an `agentType` that does not exist as a compilable agent must cause the launch to fail early with a clear error that names the missing type, rather than producing containers that crash at startup.
- The solo-agent launch path (no `--team` flag) must continue to work unchanged. Compiling additional agents that a solo launch does not use is acceptable only if it does not regress solo-launch startup time materially.
- Whatever path is taken, the sub-agents launched by a team member (for example, background research sub-agents) must also be able to resolve their own agent definitions. The fix must consider the full set of agents any team member might reach via delegation, not only the members listed in the team JSON.

## Sequencing

This cannot be fixed until `plans/shell-script-decomposition-and-python-consolidation.md` has landed. The decomposition plan migrates the agent compiler from Python to TypeScript, moves bare-repo and config responsibilities from shell into the server, and rewrites `launch.sh`'s team-mode block. Any fix applied to the current code would conflict with that rewrite and would target code paths that are about to be replaced.

After the decomposition plan lands, revisit this issue against whatever shape the launch path, compilation model, and team launcher have at that point.

## Workaround

None. Design team launches against any project are non-functional until a fix lands. The eleven design-role dynamic agents are present in the repository and compile individually, but there is no supported invocation path that assembles them into a working team launch.
