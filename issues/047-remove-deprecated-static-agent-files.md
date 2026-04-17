---
title: "Remove deprecated static agent files that duplicate dynamic-agent content"
priority: medium
reported-by: interactive-session
date: 2026-04-17
status: open
---

# Remove deprecated static agent files that duplicate dynamic-agent content

## Problem

Container agents are now compiled dynamically from skills under `skills/` via the dynamic-agent compile pipeline. Several static agent definitions remain in `agents/` that duplicate content now authoritative elsewhere. `agents/container-orchestrator.md` has been confirmed inactive — it duplicates the protocol canonicalised in `skills/orchestrator-phase-protocol/SKILL.md`. Whenever the protocol changes, the two files drift unless edited in lockstep, and the static copy can be loaded into a context by mistake, serving stale guidance.

## Required behavior

- No static agent file in `agents/` may duplicate protocol or behavioural content that is authoritative in a skill.
- The set of `agents/*.md` files that are still live (e.g. any not yet migrated to dynamic compilation) must be explicitly identified and retained. Every other `agents/*.md` file must be removed.
- Every consumer (scaffold server, launch scripts, `scaffold.config.json`, CLAUDE.md, skills, docs) referencing a removed static agent file must be updated to reference the dynamic-compiled equivalent, or the reference must be removed.
- After removal, `grep -rn '<removed-filename>' D:/coding/ue-claude-scaffold` returns zero hits outside of git history.
