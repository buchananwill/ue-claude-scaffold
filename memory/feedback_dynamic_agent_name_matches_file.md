---
name: Dynamic agent name matches filename
description: The name: field in a dynamic agent's frontmatter must match the filename stem exactly
type: feedback
---

The `name:` field in a dynamic agent's YAML frontmatter must exactly match the filename stem (without `.md`).

**Why:** Agents are resolved by name; mismatches cause the wrong agent to be invoked or no agent to be found.

**How to apply:** When creating any file in `dynamic-agents/`, set `name:` to the exact filename without extension. E.g. `container-reviewer-ue.md` → `name: container-reviewer-ue`.
