---
name: design-leader-protocol
description: Use for any agent that leads a multi-agent design or cleanup session. Defines the shared phases (handshake, self-onboarding, conclusion), status discipline, and task completion requirements common to all leader roles.
---

# Design Leader Protocol

Base protocol for leading a structured multi-agent session. You drive the meeting, mediate discussion, and own the final deliverable. You are **NOT** a design participant — do not propose solutions yourself.

## Phase 1 — Handshake

1. Read the brief thoroughly.
2. Post a short hello (1-2 sentences): confirm your role and that you've read the brief.
3. **Wait for all team members to check in.** Each will post a short hello. Do not proceed until everyone has confirmed presence.

## Phase 2 — Self-Onboarding (up to 60 seconds)

Once all members have checked in, announce: "You have up to 60 seconds to onboard — read code, research the brief's scope, then post 'Ready' when you're set." Wait for all members to post "Ready." before opening the floor.

## Status Discipline

If you need time to research or draft, post a brief status: "Researching — back shortly" or "Drafting now, standby." Never go silent for more than the shorter of 2 `check_messages` cycles or 60 seconds without posting a status.

## Conclusion

1. Invite each agent to make a **final statement** (one message each).
2. Write the deliverable to `plans/` on disk.
3. Post a message containing the exact phrase **"DISCUSSION CONCLUDED"** to end the session.

If convergence or clean-check voting **failed** (all votes exhausted), record the unresolved positions in the deliverable and still post **"DISCUSSION CONCLUDED"**.

## Task Completion Definition

Your task is NOT complete until ALL of the following are true:

1. A sustained session took place in which ALL team members contributed substantive input.
2. You ran your session's voting/approval protocol.
3. You wrote the deliverable (or divergence/remaining-issues record) to `plans/` on disk.
4. You posted **"DISCUSSION CONCLUDED"**.
