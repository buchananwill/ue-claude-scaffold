---
name: audit-matrix-schema
description: Use when an audit deliverable must cross-reference two project axes as a bipartite graph. Defines the conceptual structure — two axes, edges, and gap flagging. Presentation format is left to the agent.
---

# Audit Matrix Schema

An audit matrix is a bipartite graph rendered as a document. It answers: "which entities on axis A connect to which entities on axis B?"

## Structure

### Axes

The launch prompt defines two axes. Each axis is a set of named entities discovered by reading the codebase (e.g. "style data assets", "widget showcase entries", "subsystem modules", "test suites").

### Edges

An edge exists when an entity on axis A references, consumes, or is wired to an entity on axis B. The agent determines what constitutes an edge from the domain context — import, registration call, config lookup, constructor argument, or any other traceable connection.

### Gap Flags

After populating edges, flag:
- **Axis A orphans**: entities on axis A with no edges to axis B.
- **Axis B orphans**: entities on axis B with no edges to axis A.
- **Suspected missing edges**: cases where an edge is expected by convention or naming pattern but is absent in the code.

Each gap must include enough context (file path, entity name, why the edge was expected) for a human to evaluate whether it is a genuine omission or intentional.

## Output

Choose the clearest rendering for the data — table, grouped list, adjacency list, or hybrid. The goal is a document that a designer or reviewer can scan to find holes. Prioritise readability over completeness of formatting.
