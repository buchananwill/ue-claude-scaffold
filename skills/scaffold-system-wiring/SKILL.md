---
name: scaffold-system-wiring
description: Agent resolution table, review mandates, and terminal style sweep for the scaffold development orchestrator running inside a Docker container against the ue-claude-scaffold project.
axis: environment
---

## Agent Resolution

### Agent Resolution Table

| Role              | Agent                             | Purpose                                                  |
|-------------------|-----------------------------------|----------------------------------------------------------|
| `implementer`     | `scaffold-implementer`            | Writes TypeScript, shell scripts, agent/skill markdown   |
| `safety-reviewer` | `scaffold-safety-reviewer`        | SQL injection, input validation, shell injection         |
| `reviewer`        | `scaffold-correctness-reviewer`   | Logic, spec compliance, async correctness, API contracts |
| `decomp-reviewer` | `scaffold-decomposition-reviewer` | File bloat, module sprawl, DRY violations                |
| `style-sweep`     | `scaffold-style-sweep`            | Terminal style pass: edit-in-place, build, test, single commit. Never touches React component discipline. |

Note: there is **no per-phase `style-reviewer` row** in this wiring. Style normalisation runs once at the end of the plan as the terminal style sweep (see Style Sweep Commands below, and the Final Stage — Style Sweep section of `orchestrator-phase-protocol`).

### Review Agent Mandates

Each reviewer assesses only its own dimension. Do not ask the safety reviewer about naming — naming lives under style, which is handled by the terminal sweep, not per-phase review. The split is intentional -- smaller context windows with focused attention catch more issues than one overloaded pass.

These agents have scaffold conventions, TypeScript patterns, and enforcement baked into their definitions. Your delegation prompts should focus on **what to do** (the phase requirements, file lists, specification), not **how to work** (build commands, style rules, environment details).

## Style Sweep Commands

The terminal style sweep (`style-sweep` → `scaffold-style-sweep`) sources its build and test commands from the environment skills it composes — see that agent's definition for the exact commands. Your delegation prompt to the sweep provides:

- The git diff range (`<branch-base>..HEAD`)
- The full list of changed files produced by `git diff <branch-base>..HEAD --name-only`, filtered to the scaffold's source extensions (`.ts`, `.tsx`, `.sh`, and `.md` under `agents/`, `dynamic-agents/`, or `skills/`)
- The commit message format: `Style sweep: normalize <N> files post-plan`

Do not supply build or test commands in the delegation prompt — the sweep already loads `scaffold-environment`, `scaffold-server-patterns`, `scaffold-dashboard-patterns`, `typescript-async-safety`, and `scaffold-test-format` from its skill composition.
