---
title: "Server must retry builds that fail due to external UBT lock contention"
priority: medium
reported-by: interactive-session
date: 2026-03-20
---

# Server must retry builds that fail due to external UBT lock contention

## Problem

The coordination server's UBT lock only tracks agents within the container pipeline. If the user is
building from their IDE or an interactive session, the server doesn't know. When a container's build
request hits the host and UBT is already locked by an external process, the build fails with a
lock/access error.

The server returns this failure directly to the container agent. The agent sees a build failure it
can't diagnose or fix — it's not a compiler error, it's infrastructure. This is exactly when agents
give up, stop following protocol, and waste the rest of their turns confused.

## Design principle

The **server** must own retrying for infrastructure failures. The agent in the container is expecting
to wait for builds — builds are slow. The server should protect the agent from transient
infrastructure issues the agent can't control. The agent should only ever see genuine compiler
success/failure, never UBT lock contention.

## Proposed fix

In the build route (`server/src/routes/build.ts`), after `runCommand` returns:

1. Inspect the output/stderr for UBT lock contention signatures (specific error strings or exit
   codes — needs investigation of what UBT produces when locked).
2. If contention detected: wait (e.g. 30s), then retry the build. Up to N retries (e.g. 5,
   totalling ~2.5 minutes of waiting).
3. If the build eventually succeeds or fails with real compiler errors: return that result.
4. If retries exhausted and still locked: return a clear error indicating external UBT contention,
   not a build failure. The agent can then wait and retry at its own level rather than trying to
   "fix" a non-existent code problem.

## Investigation needed

- What does UBT output when it can't acquire its internal lock? (exit code, stderr patterns)
- Is it a file lock, a named mutex, or something else?
- Can we detect it reliably without false positives?
