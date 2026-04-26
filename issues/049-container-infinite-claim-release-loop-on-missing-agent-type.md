---
title: "Containers infinite-loop claiming/releasing tasks when required agent type is unavailable"
priority: high
reported-by: interactive-session
date: 2026-04-26
status: open
---

# Containers infinite-loop claiming/releasing tasks when required agent type is unavailable

## Problem

A container's compiled-agent directory is wiped and rebuilt only at container
startup, populated with the project's default agent set. When a claimed task
specifies a non-default agent type, the container has no way to fetch or
compile that agent type at runtime — there is no in-container trigger for
compilation and no host-side endpoint that serves the required agent
definition on demand.

The container fails the task and releases it back to the queue. On the next
poll cycle, the same container (or a peer in the same state) re-claims the
same task, fails for the same reason, and releases it again. This continues
indefinitely: the task never reaches `completed`, no other progress is made,
and the container burns session budget producing no work while appearing
"running" to the operator.

## Required behavior

- A container must be able to obtain any agent type registered for its
  project at runtime, without requiring a container restart. The agent
  compilation/download path must be reachable from inside a running
  container when a claimed task requires an agent type not currently
  present.

- A hard infrastructural failsafe must terminate a container that is
  clearly in a degenerate loop. Specifically: if a container aborts and
  releases tasks more than 20 times in a row without any task reaching
  `completed` status, the container must shut itself down (or be shut
  down by the server) as a presumed infrastructural failure. The shutdown
  must be visible in the dashboard and logs so the operator can
  investigate the underlying cause rather than discovering the loop by
  accident.

- The failsafe counter must reset on any successful task completion, so a
  container that recovers from a transient problem is not penalised.
