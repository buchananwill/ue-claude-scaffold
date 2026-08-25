# Agent Promotion Assessment — Which Compiled Agents Are Worth Exporting

**Date:** 2026-07-25
**Scope:** all 43 definitions in [dynamic-agents/](../dynamic-agents/), compiled with `compile-agent --all` (19,003 lines of compiled output) and assessed for promotion to portable Claude Code subagents in `~/.claude/agents/`.
**Already promoted:** `ue-implementer`, `ue-safety-correctness-reviewer`, `ue-style-decomposition-reviewer` (transcribed from the three `container-*-ue` definitions).

## The Test Applied

Each agent was scored on four questions:

1. **Substance ratio** — how much of the compiled body is transferable domain knowledge versus container plumbing (`container-git-*`, `container-build-routing`, `message-board-protocol`, FSM transition contracts) or single-repo wiring (`scaffold-*-patterns`, `project-patterns`, `*-system-wiring`)?
2. **Standalone coherence** — does the agent still have a job with no coordination server, no message board, no chat MCP, and no orchestrator above it?
3. **Marginal value** — does it cover ground not already held by the three promoted agents, the existing `docs-auditor` / `ue-source-explorer`, or the built-in `/code-review`, `/security-review`, and `/simplify`?
4. **Harness fit** — can it function as a Claude Code subagent at all? A subagent cannot spawn further subagents, has no peer channel, and returns a single final message to its caller.

## Tier A — Promote. High value, low rework.

### 1. `container-tester-ue` → `ue-test-writer`
1,118 compiled lines. Carries [test-format-schema](../skills/test-format-schema/SKILL.md) (UE5 automation test naming, `EAutomationTestFlags`, `IMPLEMENT_SIMPLE_AUTOMATION_TEST`, the `WITH_DEV_AUTOMATION_TESTS` guard, and the unity-build warning against `using namespace` in test TUs) plus [implementation-loop](../skills/implementation-loop/SKILL.md) and `ue-cpp-style`.

**Fills a real gap.** The promoted `ue-implementer` runs TDD but knows nothing about UE's automation test format — it will invent a test shape. This agent knows the shape. Highest-value remaining promotion.

**Rework:** thin. The project skin (`Resort.<System>.<Feature>` prefix, the Shipborn copyright line, `Source/PistePerfect/Private/Tests/`) is ~8 lines of a 56-line skill; parameterize it as "the project's test-name root and Tests/ directory, discovered from existing tests." Everything else is engine-level.

### 2. `container-style-sweep-ue` → `ue-style-sweep`
1,027 lines. [style-sweep-protocol](../skills/style-sweep-protocol/SKILL.md) is a genuinely different mode from the reviewers already promoted: it **edits in place** and its deliverable is one commit, not a findings report. In-scope/out-of-scope transformation lists are crisp, and "if a fix candidate requires a behavioural change to accomplish, skip it — style sweeps never trade behaviour for cleanliness" is the load-bearing rule.

**Pairs with what you have.** `ue-style-decomposition-reviewer` finds; this fixes. Useful interactively as "normalize the style across this branch."

**Rework:** moderate. Inlines all 612 lines of `ue-cpp-style` — the portable version should load it as a skill like the other three do. Needs the clang-format section added (same treatment as `ue-implementer`). Drop the `[STYLE SWEEP]` message-board output block; keep the category-breakdown reporting format, which is good.

### 3. `container-auditor-ue-slate` → `ue-slate-auditor`
226 lines. [ue-slate](../skills/ue-slate/SKILL.md) is solid engine-level knowledge (style-set registration lifecycle, `SLATE_ARGUMENT`/`ATTRIBUTE`/`EVENT`/`STYLE_ARGUMENT`, widget ownership, the four footguns including silent name-typo failures and brush-ownership crashes). [audit-protocol](../skills/audit-protocol/SKILL.md) carries the best single paragraph in the whole roster:

> If the meaning, purpose, or ordering of a value is not explicitly stated in the source material, do not guess. Write: "the meaning/purpose/ordering of X is not documented in the source." Never fill gaps with plausible-sounding interpretations.

**Fills a real gap.** Nothing in the global set documents UE code. Read-only against code, writes markdown deliverables — exactly the shape that works as a subagent.

**Rework:** minimal. Strip `container-git-write`; keep `commit-discipline`.

### 4. `scaffold-typescript-type-reviewer` → `typescript-type-reviewer`
627 lines, and **the most portable agent in the roster** — zero UE dependency, and its only project coupling is `container-git-readonly`. Composed of [typescript-type-discipline](../skills/typescript-type-discipline/SKILL.md) ("never define types inline"; "remap, don't duplicate"), [typescript-type-remapping](../skills/typescript-type-remapping/SKILL.md) (170 lines of mapped types, key remapping with `as`, distributive conditionals, `never` as a constraint tool), and [typescript-async-safety](../skills/typescript-async-safety/SKILL.md) (floating promises, `async` in `forEach`, `unknown` over `any`).

Useful against `dashboard/`, `server/`, and any TypeScript repo you touch. **Promote as-is minus the plumbing.**

### 5. `scaffold-dashboard-react-quality-reviewer` → `react-quality-reviewer`
885 lines. [react-component-discipline](../skills/react-component-discipline/SKILL.md) is the strongest-written skill in the repo — the Finger Rule (count `useCallback` deps on your fingers; ten deps is 1,024 states, fourteen is 16,384), covariant data grouping, false separation, and four named anti-patterns (God Callback, Null-as-Sentinel, Loose Primitives, Snapshot Amnesia). The "type constraints are landing lights / cat's eyes on a windy mountain road" passage is the kind of writing that actually changes behaviour.

**Rework:** light. Generalize the `scaffold-dashboard-patterns` layer from "Mantine + TanStack Router" to "the project's component library and router, discovered from package.json."

### 6. `scaffold-dashboard-browser-safety-reviewer` → `web-safety-reviewer`
430 lines. [browser-web-hygiene](../skills/browser-web-hygiene/SKILL.md) is explicitly framework-agnostic and reads as a tight 9-point checklist: XSS escape hatches, URL scheme allowlisting, `rel="noopener noreferrer"`, storage hygiene, CSRF on mutations, `postMessage` origin validation, clickjacking, open redirects, error leakage.

**Caveat — genuine overlap with the built-in `/security-review`.** The differentiator is shape: `/security-review` is a slash command over your working diff; this is a spawnable narrow-mandate agent you can point at arbitrary files and fan out alongside other reviewers. Promote if you want it in a fan-out; skip if `/security-review` already covers your habit.

**Rework:** one paragraph. The CSRF section hardcodes `X-Project-Id` / `X-Agent-Name` as the required headers — generalize to "the application's own required headers."

## Tier B — Promote with real rework, or conditionally.

### 7. The five arbitrators → one `arbitrator`
`fallback-arbitrator` (133), `container-arbitrator-ue` (175), `scaffold-dashboard-arbitrator` (179), `scaffold-server-arbitrator` (237), `scaffold-arbitrator` (283). **They differ only in which project-patterns skill they load** — the protocol is identical. Five collapse to one.

[arbitration-protocol](../skills/arbitration-protocol/SKILL.md) is roughly 60% FSM plumbing: the `POST /tasks/:id/arbitrations` contract, `trigger` enum matching against `arbitrationPendingTrigger`, 409 handling, the `role_session_no_op` exit-code subtlety, addendum file paths. All of that dies on promotion.

What survives is worth having: two triggers (budget-exhausted vs reviewer-contradiction), three rulings (`approve` / `rule` / `escalate`), the rule that budget-exhaustion may not produce `rule`, the convergence-versus-churn-versus-regression read across cycles, and the explicit "escalation is the correct call, not a fallback to be avoided." The upheld/retired directive format is a good output shape.

**Verdict:** promote one, expect a near-total rewrite. Interactively useful as "two reviewers gave me contradictory findings — adjudicate."

### 8. `scaffold-safety-reviewer` / `scaffold-server-safety-reviewer` → `backend-safety-reviewer`
572/576 lines, near-duplicates of each other. Value is [shell-script-safety](../skills/shell-script-safety/SKILL.md) (shellcheck-level: `set -euo pipefail` and what `-e` misses, quoting, `[[ ]]`, `eval` injection, `mktemp`) plus SQL/shell injection and error-leakage review.

**Conditional.** Perhaps half the substance is `scaffold-server-patterns` — Fastify plugin shape, Drizzle, project-id scoping. If the scaffold is your only Node backend, you'd use the in-repo agent and the promoted copy would idle. Promote only if you work on other TS backends. Overlaps `/security-review`.

### 9. `scaffold-style-sweep` / `scaffold-server-style-sweep` → `typescript-style-sweep`
697/932 lines. Same argument as the UE sweep, for TypeScript. The server variant is the better base — it adds `typescript-type-remapping` and `typescript-type-discipline`, so the sweep can fix inline types and hand-copied fields, not just formatting. Two collapse to one.

**Promote if** you normalize TS branches by hand often enough to want it. Otherwise `/simplify` plus the type reviewer covers most of the ground.

### 10. The three TS implementers — probably don't
`scaffold-implementer` (738), `scaffold-server-implementer` (1,047), `scaffold-dashboard-implementer` (1,125). These share the *entire* spine of the already-promoted `ue-implementer`: `action-boundary`, `tdd-implementation-loop`, `tdd-implementation-io-schema`, `commit-discipline`, `debrief-protocol`. They differ only in the domain stack bolted on (Fastify/Drizzle, or React/Mantine/TanStack plus web hygiene).

**Recommendation:** do not promote a second implementer. `ue-implementer`'s behaviour-contract doctrine, TDD sequence, build-gate rules, and production-code-purity section are language-neutral; only the UE-specific sections aren't. If you want a TS implementer, fork the promoted file and swap two sections — that beats maintaining a parallel 1,000-line definition.

### 11. The correctness and decomposition reviewers — low marginal value
`scaffold-correctness-reviewer` (515), `scaffold-server-correctness-reviewer` (603), `scaffold-dashboard-correctness-reviewer` (545), `scaffold-decomposition-reviewer` (418), `scaffold-server-decomposition-reviewer` (422), `scaffold-dashboard-decomposition-reviewer` (541).

[general-correctness](../skills/general-correctness/SKILL.md) and [general-decomposition](../skills/general-decomposition/SKILL.md) are **already fully inlined** in the two promoted UE reviewers — including behaviour fidelity, the anti-paraphrase rule, nesting-depth thresholds, comments-as-decomposition-signals, and the DRY/semantic-inversion rules. A TypeScript re-skin adds only the project patterns layer.

**Skip all six.** If you specifically want language-neutral versions for non-UE repos, promote exactly one of each — the substance is already written, so it is cheap, but it is duplication.

## Tier C — Do not promote.

### 12. All four orchestrators
`scaffold-orchestrator` (471), `scaffold-dashboard-orchestrator` (485), `content-catalogue-dashboard-orchestrator` (489), `scaffold-server-orchestrator` (490). Two independent blockers:

- **Harness:** a Claude Code subagent cannot spawn subagents. An orchestrator whose entire job is delegating to implementer and reviewer fan-outs cannot function in the slot you would promote it into.
- **Superseded:** per [CLAUDE.md](../CLAUDE.md), the in-container orchestrator was removed 2026-05-11 in favour of the server-managed FSM. These definitions are legacy inside the scaffold too.

**Salvage, and it is worth taking.** [orchestrator-phase-protocol](../skills/orchestrator-phase-protocol/SKILL.md) (211 lines) holds the best process discipline in the repo — one phase at a time, never bundle phases into one delegation, pass the plan path and phase id rather than paraphrasing requirements, every phase builds before review, consolidate all reviewer findings into a single fix batch instead of serial rounds, 5-cycle budget, decomposition review before the terminal sweep, and the sweep is never re-reviewed. That belongs as a **skill for your top-level interactive session**, not as an agent — it describes how *you* should drive a plan when you are the one holding the fan-out.

### 13. The design team (10 agents) + `changeling` + `cleanup-leader`
`design-leader` (181), `design-architect` (125), `design-domain` (125), `design-safety` (126), `design-critic` (127), `design-data` (129), `design-elegance` (129), `design-performance` (129), `design-ui` (133), `design-ui-mantine` (135), `changeling` (165), `cleanup-leader` (220).

Every one is built on the bundled chat MCP server (`mcp__chat__reply`, `check_messages`, `check_presence`) backed by the coordination server's rooms. [chat-etiquette](../skills/chat-etiquette/SKILL.md), [channel-isolation](../skills/channel-isolation/SKILL.md), [design-member-protocol](../skills/design-member-protocol/SKILL.md), and [design-leader-protocol](../skills/design-leader-protocol/SKILL.md) are **entirely** about multi-party turn-taking: handshake, onboarding window, floor control via `@name`, convergence votes on a halving cadence (16→8→4→2→1min→30s, max 6), strict-majority tally with the leader breaking ties, and `DISCUSSION CONCLUDED` as the sole exit signal.

Promoted as subagents these are inert. Subagents have no shared channel, cannot spawn peers, cannot see each other's messages, and return one final string to the caller. A convergence vote among agents that cannot hear each other is not a degraded protocol — it is no protocol.

**Salvage:** the five mandate skills — [mandate-critic](../skills/mandate-critic/SKILL.md), [mandate-elegance](../skills/mandate-elegance/SKILL.md), [mandate-performance](../skills/mandate-performance/SKILL.md), [mandate-data-structures](../skills/mandate-data-structures/SKILL.md), [mandate-ui-design](../skills/mandate-ui-design/SKILL.md) — are 14–16 lines each of pure evaluation criteria with **zero infrastructure dependency**. Options: one multi-lens `design-critic` agent you point at a plan file, or five skills you load in a planning session. The mandates are the transferable part of the design team; the choreography is not.

## Cross-Cutting Findings

### Live bug: five rostered design agents cannot speak
`design-critic`, `design-elegance`, `design-performance`, `design-safety`, and `design-ui-mantine` all load `chat-etiquette`, which states:

> EVERY message you want others to see MUST go through the `reply` tool… There is no other way to communicate.

But their `tools:` arrays omit `mcp__chat__check_messages`, `mcp__chat__reply`, and `mcp__chat__check_presence`. `design-architect`, `design-data`, `design-domain`, `design-ui`, `design-leader`, and `changeling` all declare them; these five do not. The compiler passes `tools` through verbatim, so the compiled output has the same gap.

These are not unused definitions — `design-performance` is rostered in [behaviour-stacks.json](../teams/behaviour-stacks.json), [core-loop.json](../teams/core-loop.json), and [crowd-field.json](../teams/crowd-field.json); `design-critic` in [example-team.json](../teams/example-team.json), [guest-behaviour-docs.json](../teams/guest-behaviour-docs.json), [inventory-ui.json](../teams/inventory-ui.json), and [loctext-discipline.json](../teams/loctext-discipline.json); `design-elegance` in [loctext-discipline.json](../teams/loctext-discipline.json) and [lm-watchdog-plan-review.json](../teams/lm-watchdog-plan-review.json).

If `tools:` is an allowlist at runtime, these five are structurally mute in every session they join — they would read the room via notifications, reason, and be unable to post. Worth an issue file and a one-line fix per definition. Unrelated to promotion; surfaced by the sweep.

### The roster collapses hard on promotion
43 definitions → **6 to 9 worth promoting**. The compression comes from three sources: per-subtree variants that differ only in a wiring skill (5 arbitrators → 1; 3 style sweeps → 1; 3 implementers → 0; 6 correctness/decomp reviewers → 0–2), agents whose substance is already inside the three promoted files, and agents that are pure coordination machinery.

### Some substance belongs in skills, not agents
Three of the best pieces of writing in the roster are not agent-shaped: `orchestrator-phase-protocol` (how to drive a phased plan), the five `mandate-*` skills (evaluation lenses), and `arbitration-protocol`'s judgment core. As skills they compose into whatever session you are already in; as agents they need a fan-out that a subagent cannot create.

## Recommended Global Roster

Promote, in this order:

1. `ue-test-writer` — from `container-tester-ue`. Biggest gap, least rework.
2. `typescript-type-reviewer` — from `scaffold-typescript-type-reviewer`. Most portable thing here.
3. `react-quality-reviewer` — from `scaffold-dashboard-react-quality-reviewer`. Best-written domain skill.
4. `ue-slate-auditor` — from `container-auditor-ue-slate`. Only documentation-producing UE agent.
5. `ue-style-sweep` — from `container-style-sweep-ue`. Completes the find-then-fix pair with the promoted style reviewer.
6. `web-safety-reviewer` — from `scaffold-dashboard-browser-safety-reviewer`. Only if you want it in a fan-out alongside `/security-review`.

Then, conditionally: `arbitrator` (one, rewritten), `typescript-style-sweep` (if you sweep TS by hand), `backend-safety-reviewer` (only if you work on non-scaffold Node backends).

As skills rather than agents: `orchestrator-phase-protocol`, the five `mandate-*` lenses.

Not at all: the four orchestrators, the ten design agents, `changeling`, `cleanup-leader`, the three TS implementers, the six TS correctness/decomposition reviewers.
