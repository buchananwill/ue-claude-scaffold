---
name: project-test-knowledge
description: Use when writing or reviewing tests in the Piste Perfect project. Existing helper catalog, category-specific test guidance, and project test conventions beyond the general test format.
---

# Piste Perfect Test Knowledge

Project-specific test truths. Read the relevant helper files before writing any tests — do not reinvent helpers that already exist.

## Helper Catalog

### Buildable Helpers (`Tests/Mock/BuildableTestHelpers.h`)
- `MakeTestModel(ComponentCount)` — flat model with N root components
- `MakeHierarchicalModel(Levels, ChildrenPerParent)` — tree-structured model
- `VerifyModelInvariants(Test, Model, Context)` — validates all model invariants
- `VerifyTreeStructure(Test, Model, Context)` — validates tree consistency
- `VerifyArrayAlignment(Test, Model, Context)` — validates aligned array sizes
- `FMockEditContext` — mock edit context for testing operations

### CrowdField Helpers (`Tests/Mock/CrowdFieldTestHelpers.h`)
- `PoisonFloat` constant — sentinel for untouched data
- `MakeSquareTileGrid(EdgeSize)` — contiguous tile grid
- `InitContiguousTileGridWithRandomHeights(...)` — full tile init
- `TestForPoison(Test, TileHandle, Data)` — verify no poison values remain

### Behaviour Helpers (`Tests/Behaviour/Mock/BehaviourTestHelpers.h`)
- `MakeEntity(Id)` — valid `FMassEntityHandle`
- `MakeStack(Behaviours)` — build `FBehaviourStack`

### Scheduler Helpers (`Tests/Behaviour/Mock/SchedulerTestHelpers.h`)
- `FRunCallback` — latent command that runs a callback
- `FWaitSchedulerIdle` — latent command that waits for scheduler idle

## Category-Specific Guidance

### Buildable Tests
- **Pure data tests** — no UWorld, no actors, no subsystems
- **Always** call `VerifyModelInvariants(Test, Model)` after any mutation
- Test success paths and edge cases (empty model, single component, max depth)

### CrowdField Tests
- **Poison-fill-then-verify**: fill with `PoisonFloat`, run operation, `TestForPoison()`
- **ISPC comparative tests**: run both C++ and ISPC paths, compare with tolerance (`1e-3f` to `1e-4f`)

### Behaviour Tests
- Use `FWaitSchedulerIdle` for scheduler synchronization
- Test condition edge cases: exactly-at-threshold, just-below, just-above

### Mass Entity Tests
- Prefer testing free functions directly over full Mass infrastructure
- **NEVER** create a `UWorld` in tests
