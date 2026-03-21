---
title: "Deregistering an agent doesn't stop the container or halt its work"
priority: high
reported-by: interactive-session
date: 2026-03-20
status: done
---

# Deregistering an agent doesn't stop the container or halt its work

## Problem

`DELETE /agents/{name}` removes the agent's registration from the database, but the Docker container
keeps running. The agent continues working on its claimed task, making commits, and calling
`/build` — it just no longer appears in the agents list. The dashboard shows it as gone, but the
container is still consuming resources and pushing to its branch.

There's no server-side mechanism to signal a running container to stop.

## Expected behaviour

Deregistering an agent should result in the agent actually stopping. The current disconnect between
"the server thinks the agent is gone" and "the container is still running" causes confusion and
wastes compute.

## Options

### A. Server-initiated Docker stop

The server shells out to `docker compose --project-name claude-{agent-name} down` on deregister.
This is the most direct solution but couples the server to Docker.

### B. Agent-side polling for deregistration

The entrypoint or a background process in the container periodically checks
`GET /agents/{name}` — if 404, it self-terminates. The container is responsible for its own
shutdown. This keeps the server Docker-agnostic.

### C. Status-based signalling

`POST /agents/{name}/status` with `{"status": "stop"}` sets a flag. The container polls its own
status (already done in pump mode for the `paused` state) and exits when it sees `stop`. Deregister
then just sets this status before removing the record.

Option C fits the existing architecture best — pump mode already polls for `paused`, extending it
to `stop` is minimal. The deregister endpoint becomes: set status to `stop`, then delete the
record after a grace period (or let the container's shutdown hook delete it on exit).

## Scope

- Whichever option: deregister must result in the container stopping within a bounded time.
- Claimed tasks must be released back to pending on agent shutdown (the entrypoint's EXIT trap
  already does this).
- The dashboard's "deregister" button should communicate that this will stop the agent, not just
  hide it.
