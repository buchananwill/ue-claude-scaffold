---
title: "Reviewers default to NOTE when they should BLOCK"
priority: high
reported-by: interactive-session
date: 2026-05-17
status: open
---

# Reviewers default to NOTE when they should BLOCK

## Problem

Reviewer sessions are routinely producing findings that read like real
defects — duplicated logic, magic literals, hand-rolled equivalents of
library algorithms, mixed-type discipline within the same file, dead
code, comment-as-name blocks, implicit-vs-explicit semantics — and
classifying them as NOTE. The verdict comes back APPROVE. The next
cycle inherits the same code, the same reviewer, and the same NOTE.

The current schema makes this trivially possible: any finding the
reviewer is unwilling to commit to at >=40% confidence can be parked
in the NOTE tier, and NOTE never affects the verdict. The reviewer
faces no friction for hedging. The aggregate effect is that the review
phase signs off on code the reviewer's own report says is wrong,
because the reviewer wrote it up as "worth aggregating across tasks"
instead of "fix this cycle."

Concretely on recent tasks:

- The decomposition reviewer filed "Snapshot-acquisition scaffolding
  duplicated across four processors" as a NOTE. This is the literal
  textbook DRY violation that decomposition review exists to catch
  — same scaffolding, four copies, identified by the reviewer
  itself — and it landed as a non-blocking observation rather than
  as the BLOCKING finding it plainly is. The reviewer's domain is
  decomposition; if four-way duplication does not clear that bar
  there is no finding it ever will.
- A reviewer noted three near-identical method bodies differing only
  in sign, recommended a parameterised helper, and approved.
- A reviewer noted a magic string used twice as a type discriminator,
  recommended hoisting to a named constant, and approved.
- A reviewer noted commented-out dead code adjacent to the live
  return, recommended deletion, and approved.

In each case the engineer's next iteration left the code untouched,
because nothing in the FSM treats NOTE as actionable. The reviewer's
judgement was correct; the verdict it produced was wrong.

## Why it is happening

The review-output-schema rubric is the load-bearing piece. It says:
"BLOCK any finding you're at least 40% confident about and that
requires action this cycle. NOTE any finding below 40% confidence OR
any finding that does not require action but is worth aggregating
across tasks." The escape hatch is the second clause. A reviewer who
is 80% confident a literal should be hoisted, but unsure whether
"requires action this cycle" applies, can route the finding to NOTE
without violating the rubric. The schema explicitly tells them NOTEs
"never affect the verdict," which removes any cost to taking that
exit.

The skill prose around the rubric reinforces the soft posture —
"observability-only," "worth aggregating across tasks" — and there
is no counterweight pushing the reviewer to commit. The reviewers
are following the schema. The schema is the problem.

## Root cause investigation required

The schema escape hatch above is the proximate cause — it explains
how a meek finding survives the pipeline. It does not explain why
the reviewer is meek in the first place. A reviewer that genuinely
believed four-way duplication was a defect would have written it up
as BLOCKING and lived with the verdict; the fact that the same
reviewer that identified the duplication also chose to file it as a
non-blocking observation says something about the reviewer's
disposition, not just about the rubric.

Before changing the schema, the underlying cause of the meekness
needs to be isolated. Candidates to rule in or out:

- **Model selection.** Whether the reviewer role is running on a
  model that systematically hedges relative to the engineer role.
  Compare verdict assertiveness across model variants on the same
  diff.

- **Composed system prompt.** Whether the union of skills loaded by
  the reviewer agent definition (review-process, review-output-schema,
  domain skill, plus any shared review preamble) is producing tonal
  drift toward caution — phrases like "observability-only," "worth
  aggregating," "do not pad," and "do not report below 50%" stack
  into a posture of withholding even when the rubric formally
  permits blocking.

- **Context noise.** Whether the reviewer's prompt is loaded with
  enough scaffolding context, FSM mechanics, JSON schema rules, and
  per-cycle metadata that the core "is this code good" judgement
  gets crowded out. Reviewers may be spending their attention on
  protocol compliance and producing a defensive output as a result.

- **Per-task prompt content.** The dispatch prompt the reviewer
  receives from the fanout — what task it is reviewing, what cycle,
  what prior findings exist. Whether anything in that prompt
  implicitly tells the reviewer that the engineer has already
  iterated and deserves the benefit of the doubt.

- **Domain skill calibration.** Whether the domain skills
  (ue-decomposition, ue-correctness, ue-safety, general-decomposition,
  general-correctness) describe their criteria in terms aggressive
  enough that the reviewer treats violations as defects, or whether
  they read as guidance the engineer "should consider" and the
  reviewer therefore treats as advisory.

The dispatch prompts written at the call site are not the suspect.
They state the reviewer's purpose plainly; reviewers are not failing
to understand what they were asked to do, they are failing to commit
to the judgements they themselves reach. The cause lives upstream of
the per-task prompt — in the model, the composed skill bundle, or
the context budget the reviewer is operating within. Identify which
before changing the schema; otherwise a stricter schema will just
push the meekness into a different shape.

## Required behavior

- A reviewer that identifies a real defect in the changed code — by
  the standards of the domain skill it composes — must produce a
  finding that blocks the cycle. The reviewer must not have a route
  by which a real defect lands as a non-blocking finding and the
  verdict comes back APPROVE.

- "Requires action this cycle" must not be a separate axis the
  reviewer evaluates. If the finding is real and the reviewer is
  confident in it, the engineer must address it before the cycle
  closes. The reviewer's job is to identify defects; sequencing of
  fixes across cycles is not its decision to make.

- The reviewer's confidence calibration must be aggressive. A
  reviewer with code evidence in front of it should be willing to
  state a finding at high confidence; reviewers that systematically
  hedge in the 30-50% band are not exercising judgement, they are
  avoiding it. The rubric must push reviewers toward committing, not
  toward the safe middle.

- Whatever survives as a "NOTE-shaped" output — if anything does —
  must not be reachable from the reviewer's normal classification
  flow for findings about the changed code. If a non-blocking tier
  exists at all, it must be reserved for observations that are
  structurally outside the cycle's scope (e.g. cross-task pattern
  trends), not for findings the reviewer was uncomfortable
  defending.

- The verdict surface must reflect the reviewer's actual judgement.
  An APPROVE from a reviewer whose own report lists defects in the
  changed code is a contradiction; the schema must make that
  contradiction impossible to produce.

## Sequencing notes

- The change is to `skills/review-output-schema/SKILL.md` and the
  rubric it defines; reviewer agent definitions compose this skill
  and inherit whatever stance it takes. Per-agent prose tweaks are
  not the right surface.

- Existing reviewer behaviour is the calibration baseline. After the
  schema change, the first few cycles will produce more REQUEST
  CHANGES verdicts than before; that is the intended direction, not
  a regression.
