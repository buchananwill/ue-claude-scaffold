---
title: "Orchestrator must enforce full plan/implement/review/test/review cycle per phase"
priority: high
reported-by: interactive-session
date: 2026-03-21
---

# Orchestrator must enforce full cycle per phase

## Problem

The container-orchestrator is allowing multiple phases to land in a single commit. Sub-agents are
bundling work across phase boundaries instead of completing one phase, building, reviewing, and
committing before starting the next.

This defeats the purpose of phased plans — each phase is meant to be a self-contained, independently
verified unit. When phases are merged together:
- Review findings can't be attributed to a specific phase
- A failure in phase 3 contaminates work from phases 1-2
- The user can't review or roll back at phase boundaries
- The audit trail (message board) doesn't match the git history

## Required cycle per phase

For each phase, the orchestrator must enforce this exact sequence:

1. **Implement** — delegate to implementer with the phase's requirements only
2. **Build** — implementer must build and achieve a clean compile
3. **Review** — delegate to reviewer against the phase's specification
4. **Fix** — if BLOCKING or WARNING issues, back to implementer, then re-review (up to 5 cycles)
5. **Commit** — all phase work committed as a distinct commit or commit series
6. **Post** — `phase_complete` message to the board

Only after step 6 does the orchestrator advance to the next phase. The implementer must not be
given requirements from multiple phases in a single delegation.

## Root cause

The orchestrator definition says "each phase should land as a distinct commit or series of commits"
but this is phrased as a suggestion, not an enforcement rule. The orchestrator needs stronger
language that makes multi-phase bundling a protocol violation.
