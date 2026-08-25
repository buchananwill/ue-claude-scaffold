---
title: "FSM completed a task whose own debrief declares unbuilt phases; reviewers approved the partial delivery"
priority: high
reported-by: interactive-session
date: 2026-08-13
---

# FSM completed a task whose own debrief declares unbuilt phases

Task 220 (piste-perfect, mutation-conformance package) reached `completed` with double `approve`
at review cycle 3. Its committed debrief (`debrief-1438`) states plainly: "Not yet convicted,
because the gates do not exist yet: the funnel rule and the field-visibility rule (phase 6)", and
its risks section records 16/39 mutator coverage with the follow-up "ordered" in its plan's
"What remains" section. The two `.clang-rules` entries are the spec's central enforcement
decisions (14–15). Nobody blocked: reviewers reviewed the code that exists rather than diffing
delivery against the spec's decision list, and the host's arrival gate (build + full test sweeps)
is structurally blind to a compiler rule that was never written.

The honest-agent path worked — the gap is fully documented in the container's own artifacts — but
"completed" is the wrong terminal state for a run whose own plan says phase 6 of 6 was not done.

Suggested fixes, weakest to strongest:
1. A reviewer-facing checklist item: diff the delivery against the spec's numbered decisions and
   name each decision not implemented; unimplemented decisions require an explicit deferral
   verdict, not silence.
2. Mechanical: if the implementer's committed plan enumerates phases, the FSM refuses `completed`
   while any phase lacks a completion marker — a self-declared partial becomes `cycle` or a
   distinct `partial` terminal state that the host can see at a glance.
3. The debrief schema gains a required "spec decisions NOT delivered" field, surfaced in the task
   row (`result`), so the host's integration gate can fail loudly on a non-empty list.
