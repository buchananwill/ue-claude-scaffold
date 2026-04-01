---
title: scaffold-orchestrator defects vs proven container-orchestrator design
priority: high
reported-by: will
date: 2026-04-01
---

# scaffold-orchestrator Defects

The `.compiled-agents/scaffold-orchestrator.md` was derived from `agents/container-orchestrator.md` but diverges from the
proven design in ways that are either invalid, lossy, or behaviourally risky. This issue catalogs each defect against the
audit in `Notes/audit-container-vs-scaffold-orchestrator.md`.

Reference design: `agents/container-orchestrator.md` (CO)
Subject: `.compiled-agents/scaffold-orchestrator.md` (SO)

---

## 1. Invalid frontmatter field: `color`

SO includes `color: cyan` in its YAML frontmatter. This field is not in the documented agent definition schema and
should be removed.

## 2. Description omits build/review gate

CO's frontmatter description says: "Each phase must build and pass code review before advancing." SO's description omits
this. The description is used by the calling agent to decide when to delegate, so omitting the build/review gate
undersells the orchestrator's rigour.

## 3. Build Verification section does not belong in the orchestrator

SO includes a "Build Verification" subsection under Scaffold System Wiring with specific build commands (`npm run
typecheck && npm run build`, etc.). The orchestrator delegates all build work to sub-agents and never runs builds itself.
This section should not be in the orchestrator definition.

## 4. Decomposition File Targets section does not belong in the orchestrator

SO includes a "Decomposition File Targets" subsection specifying `.ts`, `.tsx`, `.sh` targets and a `git diff` command.
This information belongs in the decomposition reviewer's context. The orchestrator just delegates.

## 5. Action Boundary Discipline is noise for the orchestrator

SO includes a full "Action Boundary Discipline" section (5 principles + 4 red-flag thoughts). The orchestrator has the
broadest mandate and is already steered towards delegation by its role definition. Its tool list naturally restricts what
it can do. This section adds noise without value.

## 6. Commit Discipline overlaps with Phase Execution Protocol Step 3

SO has a standalone "Commit Discipline" section whose content overlaps with the phased commit protocol in Step 3 of the
Phase Execution Protocol. The duplication should be resolved: either deduplicate or remove the standalone section.

## 7. Orchestrator Message Discipline overlaps with Message Board Protocol

SO has both a "Message Board Protocol" section and a separate "Orchestrator Message Discipline" section with overlapping
content. These two sections need coalescing into a single section.

## 8. Missing "Senior Technical Lead" framing

CO has a dedicated section (lines 20-35) establishing the orchestrator as the highest quality authority with no human in
the loop. It instructs the agent to criticize bad decisions, not rubber-stamp, push for higher standards, and withhold
praise for mediocre work. SO omits this entirely. This is strong semantic framing and its omission is a value loss.

## 9. Missing delegation focus guidance

CO instructs: "Your delegation prompts should focus on **what to do** (the phase requirements, file lists,
specification), not **how to work** (build hooks, style rules, environment details)." SO omits this directive.

## 10. Missing content from standing instruction `02-messages.md`

CO references standing instruction `02-messages.md` for message board mechanics. SO does not reference this file, and
critical information previously injected via that instruction may have been lost. Needs investigation when the file is
available on the relevant branch.

## 11. Missing pre-existing violation policy in Step 2a

CO includes a paragraph clarifying that unambiguous style or best practice violations in files the implementer already
touched must be fixed even if pre-existing, with a definition of "unambiguous" and instruction to note pre-existing fixes
in commit messages. SO omits this. This was intended to be carried over.

## 12. Missing quality framing in Step 2b

CO states: "The goal is not to avoid failure -- it is to keep raising quality." and "The user will review and provide
input." SO omits both. The first sets the right mindset for the cycle budget. The second establishes that failure is an
acceptable outcome with a defined escalation path.

## 13. Missing decomposition rationale

CO explains why the decomposition review runs last: "This stage runs last because it may propose more invasive structural
changes than the per-phase reviewers. The tests established during earlier phases are the safety net against
regressions." SO omits this reasoning.

## 14. Missing detailed commit scope verification in Step 3

CO has detailed instructions for verifying commit scope: checking that recent commit messages reference the current phase
number or title, detecting multi-phase bundles, and providing a concrete example (`Phase 2: Add retry logic to build
route`). SO compresses this to one shorter paragraph with no example.

## 15. Decomposition step references wrong file extensions

SO's Decomposition Step 1 says "Gather the full list of `.h` and `.cpp` files" -- copied verbatim from CO. However, SO
targets a TypeScript project. The Scaffold System Wiring section earlier in SO correctly specifies `.ts`, `.tsx`, `.sh`,
creating an internal contradiction. The decomposition step must reference the correct extensions.

## 16. Step 2 reviewer delegation format is less structured

CO uses numbered items with sub-bullets for each reviewer's delegation details. SO uses inline descriptions. The CO
format is structurally cleaner and should be adopted.

## 17. Step 2a warnings policy is weaker

CO says: "There is no 'accept and proceed' for warnings -- if any reviewer flags it, it must be addressed." SO truncates
to just "There is no 'accept and proceed' for warnings." The reinforcing clause should be restored.

## 18. Error Escalation omits failure condition examples

CO includes "(build fails after retries, review cycles exhausted)" as examples of when to stop. SO omits these, removing
the concrete escape hatches that prevent infinite retry loops.

## 19. Document structure is too fragmented

SO uses multiple `#` headings separated by `---` horizontal rules, creating a flat, fragmented layout. CO uses a single
`#` heading with `##` subsections, establishing clear hierarchy. SO needs to be restructured to align with CO:

1. Heading nesting (`#`/`##`/`###`) should closely match CO's hierarchy.
2. Section ordering should be as close to CO as possible, accounting for extra/omitted material.
3. Remove `---` horizontal rule separators.

## 20. Intro paragraph implies skills-based protocol resolution

SO's intro says "Your skills define your execution protocol." This implies the agent checks loaded skills to determine
its protocol, and that no protocol exists if no skills are loaded. This is a hangover from an earlier iteration. The SO
intro paragraph should be essentially the same as CO's: stating the orchestrator's role, responsibilities, and that it
never writes code, edits files, or runs build commands itself.
