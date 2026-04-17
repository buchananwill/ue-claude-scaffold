---
title: "Container agents need a reasoning-effort cascade from scaffold config to Claude CLI launch"
priority: medium
reported-by: interactive-session
date: 2026-04-17
status: open
---

# Container agents need a reasoning-effort cascade from scaffold config to Claude CLI launch

## Problem

Opus 4.7 changed its reasoning-effort default to `xhigh`. Every Claude Code instance launched inside a container (orchestrator plus every sub-agent it spawns via the Agent tool) now runs at `xhigh` by default, which is not the intended level for most scaffold work — most container agents should run at `high`.

Reasoning effort is not a recognised field in the agent-definition frontmatter. Per the Claude API docs, effort is set only at message-creation time via `output_config.effort` on the API call, not in the agent's `.md` file. The valid values are `low`, `medium`, `high` (former default), `xhigh` (new default), `max`.

Because the scaffold's current launch pipeline does not pass any effort parameter from host configuration into the Claude CLI invocation inside the container, there is no way for the operator to control the effort level short of editing the scaffold itself. Orchestrators spawning sub-agents via the Agent tool have no way to set per-call effort either, since that parameter is not exposed through the Agent tool's interface.

## Required behavior

- The scaffold must allow the operator to specify a reasoning-effort level per container agent type (orchestrator and each sub-agent role) via scaffold configuration.
- The configured level must cascade from scaffold config through the launch pipeline into the Claude CLI invocation inside the container, so the container's top-level session runs at the configured effort.
- The configured level must also apply to sub-agents the orchestrator spawns via the Agent tool during the same container session. If the Agent tool does not currently accept an effort parameter, the scaffold must surface a route that applies the configured effort to every sub-agent invocation — either via an Agent-tool extension, a session-wide override, or an equivalent mechanism that achieves the same observable outcome.
- A sensible default must be established: container agents default to `high` unless explicitly overridden per agent type in the scaffold config.
- The effort level in use for a given run must be visible in the container's startup log and in the dashboard, so the operator can confirm what was applied without reading scaffold internals.
