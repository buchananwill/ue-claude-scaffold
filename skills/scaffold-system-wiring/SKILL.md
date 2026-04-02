---
name: scaffold-system-wiring
description: Agent resolution table and review mandates for the scaffold development orchestrator running inside a Docker container against the ue-claude-scaffold project.
axis: environment
---

## Agent Resolution

### Agent Resolution Table

| Role              | Agent                             | Purpose                                                  |
|-------------------|-----------------------------------|----------------------------------------------------------|
| `implementer`     | `scaffold-implementer`            | Writes TypeScript, shell scripts, agent/skill markdown   |
| `style-reviewer`  | `scaffold-style-reviewer`         | ESM, Fastify patterns, naming, Mantine conventions       |
| `safety-reviewer` | `scaffold-safety-reviewer`        | SQL injection, input validation, shell injection         |
| `reviewer`        | `scaffold-correctness-reviewer`   | Logic, spec compliance, async correctness, API contracts |
| `decomp-reviewer` | `scaffold-decomposition-reviewer` | File bloat, module sprawl, DRY violations                |

### Review Agent Mandates

Each reviewer assesses only its own dimension. Do not ask the style reviewer about correctness, or the safety reviewer
about naming. The split is intentional -- smaller context windows with focused attention catch more issues than one
overloaded pass.

These agents have scaffold conventions, TypeScript patterns, and enforcement baked into their definitions. Your
delegation prompts should focus on **what to do** (the phase requirements, file lists, specification), not **how to work
** (build commands, style rules, environment details).

