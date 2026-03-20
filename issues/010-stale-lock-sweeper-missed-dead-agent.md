---
title: "Stale UBT lock sweeper didn't release lock from dead agent"
priority: high
reported-by: interactive-session
date: 2026-03-20
---

# Stale UBT lock sweeper didn't release lock from dead agent

## Problem

Agent-2's container was stopped via `docker compose down`. The UBT lock remained held by "agent-2"
indefinitely. Agent-1 was blocked waiting for the lock. The stale-lock sweeper (60s interval) did
not release it.

The lock had to be manually released via `POST /ubt/release`.

## Expected behaviour

The sweeper should detect that agent-2 is no longer registered (or its container is gone) and
release the lock automatically.

## Root cause (suspected)

The sweeper likely checks lock age against `ubtLockTimeoutMs` (600s / 10 minutes). A lock held for
less than 10 minutes isn't considered stale, even if the holder is dead. The sweeper doesn't
cross-reference the lock holder against the agents table to check if the agent is still registered.

## Proposed fix

The sweeper should release the lock if **either**:

1. The lock age exceeds `ubtLockTimeoutMs` (existing behaviour — long-running timeout), **or**
2. The lock holder is not in the `agents` table (agent was deregistered or never registered)

Condition 2 catches the case where a container dies or is stopped — the entrypoint's EXIT trap
deregisters the agent, which should immediately make the lock reclaimable.

If the EXIT trap didn't fire (e.g. `docker kill` instead of `docker stop`), the agent stays
registered but stops heartbeating. A heartbeat-based liveness check would catch this too, but
the agent-table cross-reference is the simpler first step.
