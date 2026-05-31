---
name: review-output-schema
description: Use when a review agent must produce structured output. Defines the BLOCKING/NOTE/Summary/Verdict template, the two-tier confidence rubric, and the JSON shadow block consumed by POST /tasks/:id/reviews. Compose with review-process and a domain skill.
---

# Review Output Schema

Standard output format for all code reviewers. Domain-specific sections can be added between "Files Reviewed" and "BLOCKING".

## Template

```
# <Domain> Review: <brief description>

**Environment skills loaded:** <names, or "none (inline only)">

## Files Reviewed
- `<path>` (N lines)

## BLOCKING

### [B1] <Title> — `<file>:<line>` (confidence: <40-100>)
**Category**: <domain-specific category>
**Description**: <what's wrong>
**Evidence**: <the specific code path or rule reference>
**Fix**: <specific correction>

## NOTE

### [N1] <Title> — `<file>:<line>` (confidence: <0-39>)
**Category**: <category>
**Description**: <what's worth aggregating across tasks, or what you're not confident enough to block on>
**Evidence**: <code path or rule reference>
**Fix**: <recommendation, optional>

## Summary
- BLOCKING: N issues
- NOTE: N issues
- Verdict: **APPROVE** / **REQUEST CHANGES**
```

## Rules

- **Environment-skill canary.** Directly under the report title, emit `**Environment skills loaded:** <names>` naming every skill you loaded at runtime from the project checkout via the Skill tool (e.g. `ue-cpp-style`). This is a standing canary the operator reads to confirm at a glance that the project's own rulesets actually reached you this cycle — you have no message board, so this report is your only place to confirm it. If your definition told you to load such a skill but the Skill invocation failed, write `none (<skill> UNAVAILABLE)` and additionally raise the failure as a NOTE — silence here is a wiring failure the operator must see. If your definition loads nothing from the environment (all skills composed inline), write `none (inline only)`.
- Every finding must include `file:line` and a rule or evidence reference.
- Use sequential IDs: B1, B2, ... for BLOCKING; N1, N2, ... for NOTE. Do not use W-prefixed IDs.
- BLOCK any finding you're at least 40% confident about and that requires action this cycle.
- Verdict is REQUEST CHANGES if any BLOCKING exists; APPROVE otherwise. NOTEs do not affect the verdict.
- NOTE is a first-class tier alongside BLOCKING; every reviewer may emit NOTEs and they never affect the verdict.
- Do not pad either tier with borderline calls; if you cannot substantiate the finding with specific code evidence, omit it.
- Do NOT instruct an engineer to defer NOTEs. The engineer is expected to consider NOTEs for action in every review pass, with priority falling to BLOCKING issues.

## JSON shadow block

In addition to the markdown report above, every reviewer MUST emit a JSON shadow block following the markdown. The markdown report is the source of truth for human readers; the JSON is a structured shadow for Supabase queries and is consumed by `POST /tasks/:id/reviews`.

After the markdown report, emit a single fenced JSON code block (```json … ```) with this exact shape:

```json
{
  "cycle": <int>,
  "reviewerRole": "<role>",
  "verdict": "approve" | "request_changes" | "out_of_scope",
  "rawMarkdown": "<full markdown report verbatim>",
  "findings": [
    {
      "severity": "BLOCKING" | "NOTE",
      "ordinal": <int>,
      "filePath": "<path>" | null,
      "line": <int> | null,
      "title": "<title>",
      "description": "<text>",
      "evidence": "<text>" | null,
      "fix": "<text>" | null
    }
  ]
}
```

Rules for the JSON shadow:

- `cycle` is the integer review cycle supplied in your prompt.
- `reviewerRole` is the role slug supplied in your prompt (e.g. `safety`, `correctness`, `decomp`) — not the agent definition basename.
- `verdict` is `request_changes` if any BLOCKING exists, otherwise `approve`. Use `out_of_scope` only when your domain has nothing to assess on this task (e.g. a docs-only change reviewed by a safety reviewer).
- `rawMarkdown` is the full markdown report above, verbatim, as a single JSON string.
- `findings[]` mirrors every BLOCKING and NOTE entry from the markdown, with `ordinal` matching the sequential ID number (B1 → 1, N1 → 1, etc.). Severity values are upper-case `BLOCKING` / `NOTE`.
- Parse your own markdown into the JSON before emitting it. Do not abbreviate or paraphrase; the markdown stays authoritative.

The reviewer's last action before exiting is to POST this JSON payload to `${SERVER_URL}/tasks/<task-id>/reviews`. Do NOT post `/transition` — the reviewer-fanout owns that transition.

## Spec-Fidelity Finding Resolution

A BLOCKING finding that names a deviation from a spec-declared type, interface, or function signature has **restricted resolutions**. It may only be resolved by one of the following:

1. **Reverting the implementation** to the literal spec shape.
2. **Escalating the spec** as impossible, contradictory, or underspecified, and halting the phase.

The following are NOT valid resolutions:

- Adding JSDoc, code comments, commit-message prose, or debrief text that documents the deviation.
- Deferring formalization to a later phase.
- Paraphrasing the spec's intent into a looser invariant that the deviation happens to satisfy.
- Renaming the deviating type without changing its shape (e.g., from `JunctionKeyConfig` to `JunctionSchema`).

When reviewing a fix cycle, verify that the deviation's **shape** changed -- not just its documentation, naming, or surrounding prose. If the shape is unchanged, the finding is not closed: re-raise it with the same BLOCKING status and name the invalid resolution attempt explicitly in the evidence section. Do not approve a fix that leaves the deviating shape in place.
