# Empirical Audit: container-orchestrator.md vs scaffold-orchestrator.md

Comparison of `agents/container-orchestrator.md` and `.compiled-agents/scaffold-orchestrator.md`.

## 1. Frontmatter Differences

| Field | `container-orchestrator.md` | `scaffold-orchestrator.md` |
|---|---|---|
| `name` | `container-orchestrator` | `scaffold-orchestrator` |
| `description` | "...Executes a pre-authored plan E2E with no human in the loop. Each phase must build and pass code review before advancing." | "...against the ue-claude-scaffold project. Executes a pre-authored plan E2E with no human in the loop." (no mention of build/review gate) |
| `model` | absent | `inherit` |
| `color` | absent | `cyan` |
| `tools` | `Agent, Read, Glob, Grep, Bash` (no brackets) | `[ Agent, Read, Glob, Grep, Bash ]` (YAML array syntax with brackets) |

## 2. Structural / Ordering Differences

**`container-orchestrator.md`** is a single monolithic document with sections as `##` headings under one `# Container Orchestrator` heading. Section order:

1. Intro paragraph + responsibilities list
2. Your Role: Senior Technical Lead
3. Autonomous Execution Rules
4. Agent Resolution
5. Message Board (with Mandatory posts, Verbosity levels)
6. Phase Execution Protocol (Steps 1-4)
7. Final Stage - Decomposition Review (Steps 1-5)
8. Context Discipline
9. Error Escalation
10. Final Output

**`scaffold-orchestrator.md`** is composed of multiple discrete sections separated by `---` (horizontal rules), each with its own `#` heading. Section order:

1. Intro paragraph (short, references skills)
2. `# Container Git Environment (Write Access)` - entirely absent from container-orchestrator
3. `# Scaffold System Wiring` - contains Agent Resolution, Review Mandates, Build Verification, Decomposition File Targets
4. `# Action Boundary Discipline` - entirely absent from container-orchestrator
5. `# Orchestrator Phase Execution Protocol` - Steps 1-4, Final Stage, Context Discipline, Error Escalation, Final Output
6. `# Commit Discipline` - entirely absent from container-orchestrator
7. `# Debrief Protocol` - entirely absent from container-orchestrator
8. `# Message Board Protocol` - expanded with curl examples, smoke test, channels, message types, payload conventions, who posts
9. `# Orchestrator Message Discipline` - separated from the general message board protocol

## 3. Content Present in scaffold-orchestrator.md but Absent from container-orchestrator.md

| Section | Content |
|---|---|
| **Container Git Environment** | Branch model (`docker/{agent-name}`), auto-push via PostToolUse hook, prohibitions on push/branch/amend, reading other branches, visibility |
| **Scaffold System Wiring: Build Verification** | Specific build commands: `npm run typecheck && npm run build`, `cd dashboard && npm run build`, `bash -n <script>`, `npm test` |
| **Scaffold System Wiring: Decomposition File Targets** | Targets `.ts`, `.tsx`, `.sh` files; provides specific `git diff` command |
| **Action Boundary Discipline** | 5 principles (declare boundary, stay in lane, read-only means read-only, follow the plan, flag don't fix) + 4 red-flag thoughts |
| **Commit Discipline** | When to commit, commit message format with example, what not to do |
| **Debrief Protocol** | File location/naming (`debrief-NNNN-keyword-keyword-keyword.md`), timing rules, 6 required sections |
| **Message Board Protocol** | Curl command format with full example, smoke test procedure, channel descriptions, message type table, payload conventions, "Who Posts" section |
| **Orchestrator Message Discipline** | Separated as its own section from the general message board protocol |

## 4. Content Present in container-orchestrator.md but Absent from scaffold-orchestrator.md

| Section | Content |
|---|---|
| **Your Role: Senior Technical Lead** | Entire section (lines 20-35): instructions to criticize bad decisions, not rubber-stamp, push for higher standards, not praise mediocre work |
| **Agent Resolution: Role Mapping Override** | "The project's `CLAUDE.md` may have an `### Orchestrator Role Mapping` section that overrides these -- check it and use whatever it specifies. Log your resolved mapping before beginning work." |
| **Agent Resolution: Delegation Focus** | "Your delegation prompts should focus on **what to do** (the phase requirements, file lists, specification), not **how to work** (build hooks, style rules, environment details)." |
| **Message Board: fire-and-forget reference** | "All posts are fire-and-forget (`|| true`). See the standing instruction `02-messages.md` for the curl command format." |
| **Build hook context** | "A PreToolUse hook intercepts build/test commands and routes them to the Windows host. Builds work from this container. Push back on any claim otherwise." |
| **Step 2a: Pre-existing violation policy** | Extended paragraph about unambiguous style violations in files the implementer already touched (lines 164-167) |
| **Step 2b: Quality framing** | "The goal is not to avoid failure -- it is to keep raising quality." and "The user will review and provide input." |
| **Decomposition: Rationale** | "This stage runs last because it may propose more invasive structural changes than the per-phase reviewers. The tests established during earlier phases are the safety net against regressions." |
| **Step 3: Detailed commit scope verification** | Extended language about checking commit messages reference phase number/title, and specific example `Phase 2: Add retry logic to build route` |

## 5. Agent Resolution Table Differences

| Role | `container-orchestrator.md` | `scaffold-orchestrator.md` |
|---|---|---|
| `implementer` | `container-implementer` / "Writes code, builds, iterates to clean build" | `scaffold-implementer` / "Writes TypeScript, shell scripts, agent/skill markdown" |
| `style-reviewer` | `container-style-reviewer` / "Style, naming, conventions, IWYU" | `scaffold-style-reviewer` / "ESM, Fastify patterns, naming, Mantine conventions" |
| `safety-reviewer` | `container-safety-reviewer` / "Pointer lifecycles, GC, thread safety, moves" | `scaffold-safety-reviewer` / "SQL injection, input validation, shell injection" |
| `reviewer` | `container-reviewer` / "Correctness, spec compliance, invariants" | `scaffold-correctness-reviewer` / "Logic, spec compliance, async correctness, API contracts" |
| `tester` | `container-tester` / "Writes and runs tests" | `scaffold-tester` / "Writes and runs Node.js built-in test runner tests" |
| `decomp-reviewer` | `container-decomposition-reviewer` / "File bloat, nesting depth, decomposition" | `scaffold-decomposition-reviewer` / "File bloat, module sprawl, DRY violations" |

The agent names use `container-` prefix vs `scaffold-` prefix. The purpose descriptions reflect UE/C++ concerns vs TypeScript/web concerns.

## 6. Shared Content with Wording Differences

**Step 1 debrief instruction:**
- Container: "Instruction to write a debrief to `Notes/docker-claude/debriefs/` before building (see standing instruction `01-debrief.md`)"
- Scaffold: "Instruction to write a debrief to `Notes/docker-claude/debriefs/` before building" (no parenthetical reference)

**Step 2 reviewer delegation format:**
- Container: Each reviewer is a numbered item with sub-bullets describing what to delegate
- Scaffold: Each reviewer is a numbered item with inline description (no sub-bullets)

**Step 2a warnings policy:**
- Container: "There is no 'accept and proceed' for warnings -- if any reviewer flags it, it must be addressed."
- Scaffold: "There is no 'accept and proceed' for warnings." (shorter)

**Step 3 commit scope verification:**
- Container: 2 paragraphs with detailed instructions including example commit message
- Scaffold: 1 shorter paragraph, no example commit message

**Decomposition Step 1:**
- Container: "Gather the full list of `.h` and `.cpp` files"
- Scaffold: "Gather the full list of `.h` and `.cpp` files" (identical text, but the Scaffold System Wiring section above says to target `.ts`, `.tsx`, `.sh` instead)

**Error Escalation:**
- Container: "build fails after retries, review cycles exhausted" in parenthetical
- Scaffold: No parenthetical, just "stop and include in your final output"

## 7. Markdown Formatting Differences

| Aspect | `container-orchestrator.md` | `scaffold-orchestrator.md` |
|---|---|---|
| Top-level headings | Single `#` heading, rest are `##` | Multiple `#` headings separated by `---` horizontal rules |
| Section separation | No horizontal rules | `---` between each major section |
| Phase steps | `### Step 1`, `### Step 2`, etc. | `## Step 1`, `## Step 2`, etc. (one level higher) |
| Sub-steps | `### Step 2a`, `### Step 2b` | `### Step 2a`, `### Step 2b` (same level) |
| Decomp steps | `### Step 1`, `### Step 2`, etc. | `### Decomp Step 1`, `### Decomp Step 2`, etc. (prefixed to disambiguate) |
| Bold emphasis | `**bold**` used throughout | `**bold**` used throughout (same) |
| Italic in bold | `**no human in the loop**` (bold) at line 9 | "There is no human in the loop." (plain text) at line 10 |
| Intro paragraph | References "senior developer" role inline | References "Your skills define your execution protocol" |
| Code blocks | Used only in Final Output template | Used for git commands, bash commands, commit message example, git diff command |

## 8. Line Counts

- `container-orchestrator.md`: 314 lines
- `scaffold-orchestrator.md`: 516 lines

The scaffold version is 64% longer, primarily due to the additional sections (Git Environment, Action Boundary Discipline, Commit Discipline, Debrief Protocol, Message Board Protocol with examples).
