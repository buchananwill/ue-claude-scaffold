---
title: "Team reuse blocked by discussion-scope collision"
priority: medium
reported-by: interactive-session
date: 2026-05-02
status: open
---

# Team reuse blocked by discussion-scope collision

## Required behaviour

A team definition is a reusable roster — a list of agent names, types, and roles. A discussion is a single use of that roster against a specific brief. Reusing the same team for a new brief, or running a second-look discussion against the same brief, must not require renaming the team, duplicating its JSON, or otherwise touching the team definition.

Specifically:

- Launching an existing team with a new brief must succeed when no discussion using that team is currently active. The launch must produce a fresh chat room scoped to the new brief.
- Launching an existing team with a brief that has already been discussed must succeed and produce a fresh chat room. The previous discussion's chat room and history must remain intact and untouched.
- The chat room used by a discussion is scoped to the (team, brief, run) tuple — not to the team alone.
- A second concurrent launch of the same team while a prior discussion is still live should be rejected (the team's roster is in use), but the rejection must distinguish "team is currently busy" from "this team has been used before".

Surface this however the schema supports: separate `discussions` and `teams` tables, a discussion id that the chat room id is derived from, or whatever shape preserves the team roster as a stable reusable entity while letting discussions come and go.

## Why this is needed

Today, attempting to reuse a team JSON for a new brief produces a collision and the launch is cancelled. The operator has to either rename the team, fork its JSON file with a numeric suffix, or delete prior history. None of those should be required: the team roster is intrinsically reusable and unrelated to any specific discussion. The current behaviour treats team identity and discussion identity as the same thing, which is counter-intuitive and creates clutter in `teams/` (e.g. files like `vehicle-configurator-plan-review-2.json` appearing because the unsuffixed name was already taken by a prior run).

The point of authoring a team — picking the right specialist roster for a class of problem — is to use it repeatedly. Forcing duplication on every reuse erodes that value.
