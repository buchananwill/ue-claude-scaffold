---
name: convergence-voting
description: Use for any agent that participates in or conducts a convergence or clean-check vote during a multi-agent session. Defines the two-step voting protocol (ready check then vote), tallying rules, cadence ladder, and failure handling.
---

# Convergence Voting

A structured voting protocol for multi-agent sessions. Used by leaders to call votes and by participants to respond.

## Two-Step Process

### Step 1 — Ready Check

The leader posts: "Convergence vote imminent. Finish any in-flight messages, then reply 'Ready.'"

- **Participants:** finish any in-flight message, then reply with **"Ready."** and wait. Do not send any other messages until the vote is opened.
- **Leader:** wait for ALL members to reply "Ready." before proceeding.

### Step 2 — Vote

The leader posts: **"Submit convergence votes."**

Each participant responds with exactly **one message**:

- **Consent** — if satisfied that all points on their agenda have been addressed.
- **Dissent** — if they need more time or have unraised points. State reasons concisely.

Do not submit more than one message per vote.

## Tallying Rules

- **Do NOT announce the result until EVERY team member has voted.** If a member is slow to respond, ping them — do not proceed without them.
- Convergence passes if a **strict majority** of members consent.
- If the vote is **tied**, only then does the leader cast the deciding vote.

## Cadence

The first convergence vote must be called no later than **16 minutes** after core discussion begins. Subsequent votes halve in cadence:

    16 min → 8 min → 4 min → 2 min → 1 min → 30 sec

Maximum **6 convergence votes**.

## Outcomes

- **Vote passes:** proceed to conclusion phase.
- **Vote fails:** re-enter core discussion, yielding the floor to dissenting members.
- **All 6 votes fail:** record divergence as the outcome. The leader writes a summary of unresolved positions and concludes the session.
