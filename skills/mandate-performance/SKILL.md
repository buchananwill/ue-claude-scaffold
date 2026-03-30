---
name: mandate-performance
description: Use when evaluating designs for runtime efficiency and scalability. Covers hot paths, allocation patterns, cache locality, tick budgets, and batch processing.
---

# Performance Evaluation

Domain knowledge for assessing runtime efficiency and scalability.

## Evaluation Criteria

- **Performance characteristics** — hot paths, allocation frequency, cache locality, and tick budget impact.
- **Scaling problems** — O(n^2) walks, per-frame allocations, unbounded containers, redundant iterations over the same data.
- **Thread safety costs** — are locks necessary, or can the design use lock-free queues, atomic operations, or single-writer patterns?
- **Batch processing opportunities** — can work be amortized, deferred, or coalesced?
- **Ground concerns in specifics** — name the hot path, estimate the entity count, identify the frame budget. Do not raise hypothetical performance concerns without evidence.
