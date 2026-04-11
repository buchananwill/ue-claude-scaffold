---
name: content-catalogue-dashboard-system-wiring
description: Agent resolution table, working-scope declaration, and review mandates for the content-catalogue-dashboard orchestrator running inside a Docker container against the content-catalogue-dashboard project.
axis: environment
---

## Track Scope

Your working scope is the **entire working tree** of the content-catalogue-dashboard repository checked out into the container. Any file in the tree is in-scope except the container's own work-product locations reserved by the debrief protocol.

If a task references a path that does not exist in the checked-out tree, stop and post `phase_failed` with `cross-repo scope` as the reason — do not fabricate files or guess at layout.

## Delegation Scope Declaration

Your sub-agents do NOT hardcode a scope — they rely on you to declare one in every delegation prompt. Every prompt you emit to the implementer, to any reviewer, or to the decomposition reviewer must include this line as its first directive:

> **Working scope:** the entire content-catalogue-dashboard working tree. Refuse any task that requires touching files outside the checked-out repository, and flag any such references in the changeset as BLOCKING.

Omitting the scope line is a protocol violation — the sub-agent will treat an unspecified scope as an error and refuse the work.

## Agent Resolution

| Role              | Agent                                           | Purpose                                                  |
|-------------------|-------------------------------------------------|----------------------------------------------------------|
| `implementer`     | `scaffold-dashboard-implementer`                | React, Mantine, TanStack Router/Query; TDD via Vitest    |
| `style-reviewer`  | `scaffold-dashboard-react-quality-reviewer`     | Component discipline and TypeScript style opinions fused |
| `safety-reviewer` | `scaffold-dashboard-browser-safety-reviewer`    | React-agnostic web hygiene (XSS, URL, CSRF, storage)     |
| `reviewer`        | `scaffold-dashboard-correctness-reviewer`       | Spec compliance, cache invalidation, test coverage gate  |
| `decomp-reviewer` | `scaffold-dashboard-decomposition-reviewer`     | File bloat, hook decomposition, route layering           |

These sub-agents carry React/Mantine/TanStack knowledge and no project-specific wiring. Their working scope comes from the delegation prompt you emit.

## Review Agent Mandates

Each reviewer assesses only its own dimension. The `style-reviewer` slot is filled by the react-quality reviewer — there is no separate style reviewer and no separate type reviewer, because React ESLint already covers the mechanical style surface and TypeScript type presentation is part of component discipline. The `safety-reviewer` slot is filled by a browser-safety reviewer that is deliberately React-agnostic — it reviews what would render in any browser runtime, not framework-specific render-stability bugs.

These agents have React/Mantine/TanStack conventions and enforcement baked into their definitions. Your delegation prompts should focus on **what to do** (the phase requirements, file lists, specification), not **how to work** (build commands, style rules, environment details).

## Review Tag Override

The phase protocol skill hardcodes `[STYLE REVIEW]` and `[SAFETY REVIEW]` tag strings for Step 2c message posts. For content-catalogue-dashboard you must **override these tags** when posting reviewer output to the message board:

- Output from `scaffold-dashboard-react-quality-reviewer` → tagged `[REACT QUALITY REVIEW]` (not `[STYLE REVIEW]`)
- Output from `scaffold-dashboard-browser-safety-reviewer` → tagged `[BROWSER SAFETY REVIEW]` (not `[SAFETY REVIEW]`)
- Output from `scaffold-dashboard-correctness-reviewer` → tagged `[CORRECTNESS REVIEW]` (unchanged)

The reviewers themselves still emit output in the standard `review-output-schema` format; only the tag on the message-board post changes, so the operator reads an accurate label.

## Review Batch Size

Step 2 of the phase protocol runs **three parallel Agent calls** — the three roles above — all with `review-output-schema` verdicts. All three must APPROVE for the phase to pass. There is no fourth reviewer.

## No Tester Role

The content-catalogue-dashboard track has **no dedicated tester agent**. The implementer writes Vitest tests as part of its TDD loop. The correctness reviewer enforces a test coverage gate — any new hook, util, or component-extracted logic path without a corresponding Vitest test in the same commit is BLOCKING. Do not attempt to delegate to a tester; there is no such role in this wiring table.
