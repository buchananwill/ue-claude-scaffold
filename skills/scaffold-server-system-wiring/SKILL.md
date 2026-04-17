---
name: scaffold-server-system-wiring
description: Agent resolution table, review mandates, and terminal style sweep for the scaffold-server orchestrator running inside a Docker container against the server/ subtree of ue-claude-scaffold.
axis: environment
---

## Track Scope

You and your sub-agents operate **only on `server/**`**. A task that requires changes under `dashboard/**`, `container/**`, `scripts/**`, or anywhere outside the server subtree is out-of-track. The implementer refuses such tasks with a clear message; reviewers flag any such diff as BLOCKING and name `scaffold-dashboard-orchestrator` as the correct owner for `dashboard/**` work.

## Agent Resolution

| Role              | Agent                                    | Purpose                                                  |
|-------------------|------------------------------------------|----------------------------------------------------------|
| `implementer`     | `scaffold-server-implementer`            | Writes TypeScript for Fastify plugins and Drizzle queries; TDD via node:test |
| `safety-reviewer` | `scaffold-server-safety-reviewer`        | SQL injection, input validation, shell injection, auth, error leakage |
| `reviewer`        | `scaffold-server-correctness-reviewer`   | Spec compliance, async correctness, API contracts, test coverage gate |
| `decomp-reviewer` | `scaffold-server-decomposition-reviewer` | File bloat, module sprawl, DRY violations, plugin layering |
| `style-sweep`     | `scaffold-server-style-sweep`            | Terminal style pass: edit-in-place, build, test, single commit. Types fold into style. |

Note: there is **no per-phase `style-reviewer` row** in this wiring. Style normalisation — including TypeScript type-shape discipline — runs once at the end of the plan as the terminal style sweep (see Style Sweep Commands below, and the Final Stage — Style Sweep section of `orchestrator-phase-protocol`).

## Review Agent Mandates

Each reviewer assesses only its own dimension. The terminal style sweep owns **all presentation concerns**, including TypeScript type shape discipline — messy, ad-hoc, redundantly-declared types are a style defect, not a separate axis. Do not create or reference a standalone type reviewer. Do not ask the safety reviewer about naming or the correctness reviewer about type presentation.

These agents have scaffold conventions and enforcement baked into their definitions. Your delegation prompts should focus on **what to do** (the phase requirements, file lists, specification), not **how to work** (build commands, style rules, environment details).

## Review Batch Size

Step 2 of the phase protocol runs **two parallel Agent calls** — `safety-reviewer` and `reviewer` — both with `review-output-schema` verdicts. Both must APPROVE for the phase to pass. There is no per-phase style-reviewer call in this wiring; style is handled terminally.

## No Tester Role

The server track has **no dedicated tester agent**. The implementer writes tests as part of its TDD loop. The correctness reviewer enforces a test coverage gate — any new endpoint, query, or branch without a corresponding test in the same commit is BLOCKING. Do not attempt to delegate to a tester; there is no such role in this wiring table.

## Style Sweep Commands

The terminal style sweep (`style-sweep` → `scaffold-server-style-sweep`) sources its build and test commands from the environment skills it composes — see that agent's definition for the exact commands. Your delegation prompt to the sweep provides:

- The git diff range (`<branch-base>..HEAD`)
- The full list of changed files under `server/**` produced by `git diff <branch-base>..HEAD --name-only -- server/`
- The commit message format: `Style sweep: normalize <N> files post-plan`

Do not supply build or test commands in the delegation prompt — the sweep already loads `scaffold-environment`, `scaffold-server-patterns`, `typescript-type-remapping`, `typescript-type-discipline`, `typescript-async-safety`, and `scaffold-test-format` from its skill composition.
