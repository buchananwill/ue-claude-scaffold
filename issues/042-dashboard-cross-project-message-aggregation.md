---
title: "Dashboard has no cross-project message view"
priority: medium
reported-by: interactive-session
date: 2026-04-07
status: needs-design
---

# Dashboard has no cross-project message view

## Problem

The dashboard's message page is scoped to a single project at a time. To see what's happening across the four projects currently registered (`piste-perfect`, `content-catalogue-dashboard`, `procedural-geometry-ideas`, `ue-claude-scaffold`), the operator must switch the project filter and reload, four times, manually correlating timestamps in their head. There is no aggregated view.

This becomes a real problem the moment more than one project has agents running. The operator wants a single pane that surfaces "what's the most recent thing that happened anywhere" without having to know in advance which project is active. Today, the only way to get that is to poll the server's `/messages` endpoint per project from the terminal.

## Why this needs a design session before implementation

The straightforward "merge everything chronologically" answer is not obviously right. Several decisions interact and need to be pinned down together rather than discovered during implementation.

## Open questions for the design session

1. **Page location.** Is this a new top-level route (e.g. `/messages/all`), a new tab on the existing project messages page, or a default landing view that replaces the current per-project page when no project is selected?
2. **Message → project attribution.** Each row needs to identify its source project at a glance. Options: project name as a leading badge, color-coded background per project, grouped sections per project, or a project column in a table layout. Which reads best when the volume is high?
3. **Channels.** Does the aggregated view show only `general`, or every channel across every project? Including agent-private channels (`<role-name>`) would be high noise; excluding them hides sub-agent activity that might matter.
4. **Sort and merge strategy.** Strict chronological merge across projects, or per-project columns side-by-side? Strict merge gives a single timeline but loses visual locality; columns preserve locality but are harder to read at high volume.
5. **Filter controls.** All-projects vs. a multi-select subset. The filter state needs to persist across reloads — query params, local storage, or server-stored user preference.
6. **Pagination and tail size.** How many recent messages per project does the initial load fetch? A naive "last 50 across all projects" can starve a busy project. A naive "last 50 per project" inflates payloads. Likely need a cursor strategy that respects the merge.
7. **Live updates.** The current per-project page polls. Aggregated polling either fans out (one request per project) or needs a new server endpoint that returns merged results. Which is acceptable, and at what poll interval? Server-sent events or websockets are out of scope unless the design session decides otherwise.
8. **Server endpoint shape.** Does the dashboard call existing `GET /messages?project=X` four times and merge client-side, or does the server expose a new `GET /messages/all?since=<cursor>` that does the merge server-side? The latter is cheaper and lets the server enforce consistent ordering, but adds an endpoint to maintain.
9. **Message-id namespace.** Message ids are currently per-server-global integers (not per-project), so cross-project sorting by id is well-defined. Confirm this is true after the multi-tenancy migration before designing the cursor.
10. **Read state.** Should the operator be able to mark messages as read or dismissed? If so, is read-state per-project or global? Today there is no read-state at all; introducing it would mean a new schema column.
11. **Drill-down behavior.** Clicking a message in the aggregated view — does it deep-link into the project-scoped page filtered to that message's context, open a side panel, or do nothing? What about clicking the project badge?
12. **Empty and quiet states.** A project with no recent activity should not vanish from the view (the operator might be waiting to see something happen there). How is "quiet project" surfaced — placeholder row, dim section header, last-activity timestamp?
13. **Color and badge palette.** With four projects today and likely more later, the palette needs to scale. Hand-picking colors per project doesn't. A deterministic hash from project id is the standard answer but tends to produce ugly combinations. Resolve before implementation.
14. **Relationship to the existing per-project page.** Is the aggregated view a replacement or an addition? If both coexist, the navigation between them needs to be obvious without cluttering the header.

## Proposed next step

Run a short interactive design session (operator + assistant, no agents) that walks the question list above and produces a one-page design doc covering:

- Final answers to each question
- A wireframe (text or sketch) of the chosen layout
- The exact server endpoint signature, if a new one is needed
- The schema additions, if any (likely none unless read-state is in scope)
- Acceptance criteria for the implementation phase

Park this issue at `status: needs-design` until that doc exists. After the design doc is committed, this issue gets reopened with `status: open` and the implementation plan becomes a normal feature task with explicit phases.

## Sequencing

Not blocked by the shell-script-decomposition plan. Can be designed in parallel and implemented anytime after. If the shell-script-decomposition plan happens to add a server-side `GET /status` endpoint (Phase 13) that already merges across projects, evaluate whether that endpoint can be extended to cover the message aggregation case rather than introducing a second merged endpoint.
