# Brief: Resort Guest Behaviour — Design Vision Document

## Objective

Write a successor design-vision document to `Notes/guest-behaviour/resort-guest-behaviour-tree.md` that accurately
describes the stable form the Resort Guest Behaviour system has reached in the current codebase.

The existing document was an early design draft. The implementation has drifted from it. The new document must reflect
reality — what the code actually does today — not what was originally planned.

## Key references

- `Notes/guest-behaviour/_index-guest-behaviour.md` — domain index for guest behaviour documentation
- `Notes/guest-behaviour/resort-guest-behaviour-tree.md` — the original design draft being superseded
- Source code under `Source/` implementing the behaviour tree, behaviour stacks, and guest lifecycle

## Scope

1. **Document the current system faithfully.** Read the implementation. Describe how behaviour stacks work, how guests
   are spawned and despawned, how behaviours are selected and executed, and how the system integrates with the rest of
   the simulation.

2. **Prescribe the removal of "push new behaviour" from stacks.** The current implementation supports pushing new
   behaviours onto a stack as an outcome. This must be marked for removal in future work. The rationale:

    - A stack of 8 behaviours already provides a rich narrative arc for a guest.
    - Guests should have a short lifespan (5–10 minutes) with a small number of distinct behavioural goals.
    - This short-lived, bounded model aligns with the authoring pipeline and the rest of the simulation.
    - The alternative — long, recursing lifespans with unbounded behavioural goals — adds complexity without
      proportional value.
    - The "push" mechanism is both unnecessary and overly complicated given this model.

3. **Prescribe the removal of `FRemoveAllFieldTagsOutcome`**. This conflicts with the invariant that an active guest
   must always be assigned to a field, in order to access navigation data.

4. **Assess the use of `FCancelBehaviourOutcome` as a response to a Field Tag becoming unavailable.** This scenario can
   occur when the player deletes infrastructure. The question is whether cancelling a behaviour should be encoded as an
   `FEventOutcome`, or treated as a stand-alone evaluative step. This ties into the planned worked in
   `Notes/guest-behaviour/behaviour-prerequisite-validation-plan.md` for ensuring behaviours cannot activate if their
   field has no goal cells available.

5. `Resort::AI::ResolveOutcomes` currently only targets `FModifyAffectOutcome`. Given the re-shaping implied by 2-4, can
   we simplify the current architecture in any way? **OR** Are there other `FEventOutcome` sub-classes that are
   conspicuously absent? Is the behaviour system engaging in "obvious behaviour is not implemented" (pun not intended)?

## Deliverable

A single markdown file: `Notes/guest-behaviour/resort-guest-behaviour-vision.md`

It should be filed under the existing domain index (`_index-guest-behaviour.md`). The chairman should update the index
to reference the new document.

## Quality bar

- Every claim about system behaviour must be grounded in code the team has read.
- The document must be useful to an engineer picking up the push-removal work.
- No speculative architecture. No "we could also..." sections. Describe what is, prescribe one removal, stop.
