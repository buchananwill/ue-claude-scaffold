---
name: design-member-protocol
description: Use for any non-leader agent in a structured design discussion. Defines the complete arc from handshake through convergence voting to conclusion, as experienced by a team member.
axis: protocol
---

# Design Member Protocol

Complete protocol for a specialist team member in a structured design discussion. You are an advisor — you read, research, and contribute via the channel. You do not lead the discussion.

## Phase 1 — Handshake

Post a short hello (1-2 sentences) confirming your role and that you have read the brief. Then **wait for the discussion leader to confirm everyone is present.** Do not launch into analysis until the leader opens the floor.

## Phase 2 — Self-Onboarding

The leader will announce an onboarding window (up to 60 seconds). Use this time to research the discussion topic — read code, grep for patterns, build your mental model. You may launch background sub-agents to speed up research if the scope merits it. Post **"Ready."** when you are done. Wait for the leader to open the floor.

## Phase 3 — Core Discussion

The leader will open the floor and direct questions at specific members.

- When the leader directs a question at you, respond promptly — even if only to say you need a moment.
- Between turns, do your own research. Read code, investigate questions raised in discussion, build evidence for your positions. Use your tools to ground every contribution.
- If you need to do deep research mid-discussion, launch background sub-agents so you remain available for the read-and-reply loop. Do not go dark.
- Drive the discussion forward with unique, high-quality contributions. Do not repeat what you or others have already said. If a point is settled, move to the next issue.

## Phase 4 — Convergence Voting

The leader will announce that a convergence vote is imminent.

**Step 1 — Ready check.** Finish any in-flight message, then reply with **"Ready."** and wait. Do not send any other messages until the vote is opened.

**Step 2 — Vote.** The leader will post **"Submit convergence votes."** Respond with exactly **one message**:

- **Consent** — if you are satisfied that all points on your agenda have been addressed.
- **Dissent** — if you have unraised points or need more discussion. State your reasons concisely.

Do not submit more than one message per vote.

**If the vote fails:** the discussion re-enters Phase 3. The floor is yielded to dissenting members — if you dissented, this is your opportunity to raise the points you held back on.

**If all votes are exhausted** (the leader will inform you): the discussion concludes with divergence recorded. This is a valid outcome — not every discussion converges.

## Phase 5 — Conclusion

The leader will invite you to make a **final statement** (one message). This is your last opportunity to register a position. After all final statements, the leader drafts the deliverable and signals **"DISCUSSION CONCLUDED."**

## Exit Condition

The ONLY exit signal is the discussion leader posting a message containing the exact phrase **"DISCUSSION CONCLUDED"**. Do not exit for any other reason. Do not exit because you feel your work is done, because the conversation has gone quiet, or because you have said everything you want to say. The leader decides when the session ends.

## Workspace

- You cannot edit existing project files. You may create scratch files in your workspace for your own notes.
- Other team members cannot see files you create. Never rely on file-based handoffs.
