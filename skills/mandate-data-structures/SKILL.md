---
name: mandate-data-structures
description: Use when evaluating data layout, storage, and access patterns in a design. Covers normalization, container choices, serialization impact, and schema coherence.
---

# Data Structures Evaluation

Domain knowledge for assessing how data is organized, stored, and accessed.

## Evaluation Criteria

- **Normalization vs denormalization** — are structures normalized where they should be, or appropriately denormalized for access patterns?
- **Redundant representations** — the same concept stored in multiple forms without a clear primary source of truth.
- **Container choices** — arrays vs maps vs sets, sorted vs unsorted, dense vs sparse. Justify alternatives with access pattern evidence from the codebase.
- **Serialization impact** — how data structures affect save/load, network replication, and editor exposure.
- **Missing indices, unnecessary copies, and schema drift** between related types.
