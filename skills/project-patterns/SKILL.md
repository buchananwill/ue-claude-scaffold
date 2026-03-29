---
name: project-patterns
description: Use when reviewing or implementing code in the Piste Perfect project. Key data structures, invariants, defensive macros, and domain-specific patterns that reviewers and implementers must know.
---

# Piste Perfect Project Patterns

Project-specific truths. These are patterns, invariants, and conventions unique to this codebase.

## Key Data Structures

- **`FBuildableActorModel`** — holds arrays of components. Mutations must keep aligned arrays (`ComponentModels`, `Transforms`, `Tree`) consistent. Freed-index list consistency and tree parent-child symmetry must be preserved. GUID uniqueness within a model.
- **CrowdField** — uses `std::array<float, CellsPerTile>`. Watch for out-of-bounds and references into tile data surviving across tile remapping. `FSynced*` tile access patterns: reading while another thread writes.
- **`ForEachCell`/`ForEachInteriorCell`** — closures. Verify capture lifetimes (safety) and correct interior vs boundary logic (correctness).
- **`FCellIndex.IsValid()`** — check before array access.
- **`TileArenaIndex`** — lookups can return invalid indices for unmapped tiles.
- **Behaviour scheduler** — async. State accessed from latent commands may have changed between scheduling and execution. Any `this` capture in a latent command callback is a potential dangling pointer.

## Defensive Macros

The project uses `UE_RETURN_IF_INVALID`, `UE_RETURN_IF_NULLPTR`, etc. (defined in `PistePerfect.h`). Acceptable at system boundaries but should not mask deeper issues — a null check doesn't fix the fact that a pointer can dangle, and an always-taken check means the logic upstream is wrong.
