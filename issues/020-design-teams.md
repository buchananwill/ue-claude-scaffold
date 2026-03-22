---
title: "Design teams: collaborative agent groups for architecture and planning"
priority: high
reported-by: interactive-session
date: 2026-03-22
status: planned
plan: plans/chat-rooms-and-design-teams.md
plan-phases: 8-17
---

# Design teams

## Problem

The current agent model is a strict engineering highway: orchestrator delegates to implementer, reviewers check the
output, work flows in one direction. There is no space for collaborative deliberation — agents that discuss tradeoffs,
sketch alternatives, critique each other's ideas, and converge on a design before any code is written.

The human operator currently fills this role alone (writing plans, making architectural decisions). But some problems
benefit from multiple perspectives explored in parallel, with the human moderating rather than authoring.

## Concept

A **design team** is a group of agents that share a chat room, receive a brief (a problem statement or question), and
collaboratively produce a deliverable (a plan, a design document, an API sketch, a set of recommendations). The human
participates in the room, can steer the conversation, and approves the final output.

Design teams do not write code. Their output is a document that feeds into the existing plan → orchestrator →
implementer pipeline.

## Design

### 1. Team definition

#### USER FEEDBACK: Add a `chairman` team member, whose role is to advocate for the spec the user supplied, and mediate the other agents' discussions, making the final decision on the submitted plan. Analogous to the `orchestrator` for engineering implementation.

Teams are defined in `teams/` as markdown files, parallel to `agents/`:

```markdown
---
name: architecture-team
description: "Explores system design alternatives and produces architectural plans"
members:
  - role: systems-architect
    agent_type: design-architect
    focus: "System boundaries, data flow, API surface"
  - role: devil-advocate
    agent_type: design-critic
    focus: "Attack assumptions, find failure modes, argue for simplicity"
  - role: domain-expert
    agent_type: design-domain
    focus: "Domain constraints, existing patterns, migration impact"
room: architecture-team
---

## Brief template

When this team is convened, each member receives the brief below with their role-specific focus area.

## Deliverable

The team produces a single markdown document in `plans/` that the orchestrator can execute.

## Protocol

1. Each member reads the brief independently and posts initial thoughts.
2. Members critique each other's proposals — disagreement is productive.
3. The user may intervene at any point to steer, constrain, or ask questions.
4. When the team converges (or the user calls it), the systems-architect drafts the final document.
5. Other members review the draft and flag gaps.
6. The user approves the final deliverable.
```

### 2. New agent types for design work

```
agents/
  core/
    design-architect.md       # proposes structures, draws boundaries
    design-critic.md          # attacks proposals, finds failure modes
    design-domain.md          # grounds discussion in project reality
```

These agents:

- Have read access to the codebase (Glob, Grep, Read) but no write access (no Edit, Write, Bash).
- Communicate exclusively through their team's chat room.
- Can reference files, quote code, and link to existing patterns.
- Do NOT run builds, modify files, or create commits.

### 3. Convening a team

```bash
# Launch a design team with a brief
./launch.sh --team architecture-team --brief briefs/new-data-model.md
```

This:

1. Reads the team definition from `teams/architecture-team.md`.
2. Creates the chat room `architecture-team` with all members + user (via `POST /rooms`).
3. Launches one container per member, each with:
    - Their role-specific agent definition (`design-architect.md` + any overlay).
    - The brief document injected as the initial prompt.
    - The chat room ID so they know where to post.
    - Read-only codebase mount (no push access to bare repo).
4. Posts the brief as the first message in the room.

### 4. Container configuration for design agents

Design containers differ from engineering containers:

| Property      | Engineering agent                     | Design agent                     |
|---------------|---------------------------------------|----------------------------------|
| Git access    | Clone + push to bare repo             | Clone only, read-only            |
| Build hooks   | Injected (external) or native (local) | None                             |
| File writes   | Full write access                     | None — read-only mount           |
| Communication | Status board (`/messages`)            | Chat room (`/rooms`)             |
| Deliverable   | Code commits                          | Markdown document posted to room |
| Tools allowed | Read, Edit, Write, Bash, Glob, Grep   | Read, Glob, Grep only            |

**Container settings for design agents** (`container/container-settings-design.json`):

#### USER FEEDBACK: The `chairman` agent should have permission to write to the planning folder, in order to produce the deliverable (or series of deliverables if the team decides their mandate should be split into separate work units).

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch"
    ],
    "deny": [
      "Edit",
      "Write",
      "Bash"
    ]
  }
}
```

### 5. Team lifecycle

```
convene → discuss → converge → deliver → dissolve
```

1. **Convene**: Containers launch, agents join room, brief is posted.
2. **Discuss**: Agents read codebase, post analysis, critique each other. Human participates. No time limit — the
   conversation runs until convergence or user intervention.
3. **Converge**: The user signals convergence (posts "let's converge" or similar). The architect role drafts the
   deliverable.
4. **Deliver**: The architect posts the final document to the room. Other members review and flag gaps. User approves.
5. **Dissolve**: User runs `./stop.sh --team architecture-team`. Containers stop. Room persists (history is valuable).
   The deliverable is saved to `plans/` (manually or via a server endpoint).

### 6. Design-to-engineering handoff

The deliverable from a design team is a plan document. The handoff:

1. User copies the approved plan to `plans/`.
2. User launches an engineering agent: `./launch.sh --plan plans/new-data-model.md`.
3. The orchestrator executes the plan through the existing phase → implement → review pipeline.

#### USER FEEDBACK: In scenarios where the design team have been given permission to prototype their deliverable, the hand-off should go through the existing task queue system. Not directly launch orchestrators. If the engineering team are not online, the work will wait in the queue. This is both better for leveraging the existing automation _AND_ gives an additional oversight mechanism to firebreak spiralling design errors (should they occur).

The plan document can reference the design team's chat room for rationale: "See architecture-team room, messages 42-67
for the tradeoff analysis."

### 7. Inter-team communication

Multiple design teams can exist simultaneously. Cross-team communication happens through:

- **Shared rooms**: Create a room with members from multiple teams.
- **The user as bridge**: The human participates in all rooms and can relay insights.
- **Published artifacts**: One team's deliverable can be the next team's input brief.

Agent-to-agent communication across teams is intentionally indirect. Direct cross-team messaging creates coordination
complexity. The human moderates the information flow.

### 8. Server changes

**New endpoints:**

```
POST   /teams                    -- register a team (creates room, records members)
GET    /teams                    -- list active teams
GET    /teams/:id                -- team details, member status, room link
DELETE /teams/:id                -- dissolve team (stop containers, keep room)
```

**New table:**

```sql
CREATE TABLE teams
(
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    brief_path   TEXT, -- path to brief document
    status       TEXT NOT NULL CHECK (status IN ('active', 'converging', 'dissolved')),
    deliverable  TEXT, -- final output (markdown)
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    dissolved_at DATETIME
);

CREATE TABLE team_members
(
    team_id    TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL REFERENCES agents (name),
    role       TEXT NOT NULL,
    PRIMARY KEY (team_id, agent_name)
);
```

### 9. Dashboard integration

The dashboard gets a teams view:

- Active teams with member status (idle, discussing, converging).
- Link to the team's chat room.
- Brief and deliverable documents.
- Timeline of team activity.

## What this is NOT

- **Not a replacement for the engineering pipeline.** Design teams discuss and plan. Engineering agents implement. The
  boundary is clear.
- **Not autonomous.** The human is always in the room. Design teams do not self-organize or spawn sub-teams.
- **Not real-time collaborative editing.** Agents post messages sequentially. There is no shared document editor. The
  deliverable is authored by one agent and reviewed by others.

## Dependencies

- Issue 019 (chat rooms) — design teams require the chat room infrastructure.
- ~~Issue 018 (generalization) — design agents use project-agnostic core definitions.~~ This is arguably distinct from the total generalization: the only generalizing change needed is to launch containers with other agent types (instead of the orchestrator) and without injecting all the UE-build-specific python scripts.
