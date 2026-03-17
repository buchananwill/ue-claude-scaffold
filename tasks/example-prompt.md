# Example Task Prompt

> **This is a template, not a real task.** Copy this structure when writing a plan
> for the container orchestrator. Place your actual prompt at the path configured
> in `TASKS_PATH` (mounted as `/task/prompt.md` in the container).

---

# Task: Add Player Statistics Tracking

## Metadata

- **Project**: MyUEProject
- **Branch**: feature/player-stats
- **Plan authored by**: Human operator
- **Date**: 2025-01-15

## Goal

Add a player statistics subsystem that tracks gameplay metrics (distance travelled,
items collected, time played) and persists them across sessions via SaveGame.
The system must be accessible from both C++ and Blueprints.

## Phases

### Phase 1 — Data Model & Subsystem

**Objective**: Create the statistics data structures and a GameInstance subsystem to own them.

**Requirements**:
- Define `FPlayerStatEntry` struct with `Name` (FName), `Value` (double), `LastUpdated` (FDateTime)
- Define `UPlayerStatsData` as a USaveGame subclass holding a TMap<FName, FPlayerStatEntry>
- Create `UPlayerStatsSubsystem` (UGameInstanceSubsystem) with:
  - `IncrementStat(FName, double Delta)`
  - `GetStat(FName) -> double`
  - `SaveStats()` / `LoadStats()` using async SaveGame API
- Load stats on subsystem `Initialize()`, save on `Deinitialize()`

**Acceptance criteria**:
- [ ] Project builds cleanly
- [ ] Subsystem is accessible via `UGameInstance::GetSubsystem<UPlayerStatsSubsystem>()`
- [ ] Stats round-trip through save/load (verifiable via unit test or manual inspection)

**File targets**:
- `Source/MyProject/Public/Stats/PlayerStatEntry.h` — struct definition
- `Source/MyProject/Public/Stats/PlayerStatsData.h` — SaveGame class
- `Source/MyProject/Public/Stats/PlayerStatsSubsystem.h` — subsystem header
- `Source/MyProject/Private/Stats/PlayerStatsSubsystem.cpp` — implementation

### Phase 2 — Blueprint Integration & UI Hookup

**Objective**: Expose stats to Blueprints and wire up a simple HUD display.

**Requirements**:
- Add `UFUNCTION(BlueprintCallable)` to `IncrementStat` and `GetStat`
- Add `UFUNCTION(BlueprintPure)` for `GetAllStats() -> TArray<FPlayerStatEntry>`
- Create a `UPlayerStatsWidget` (UUserWidget subclass) that displays stats in a vertical box

**Acceptance criteria**:
- [ ] Project builds cleanly
- [ ] `IncrementStat` is callable from a Blueprint graph
- [ ] Widget compiles and can be added to a HUD

**File targets**:
- `Source/MyProject/Public/Stats/PlayerStatsSubsystem.h` — add Blueprint specifiers
- `Source/MyProject/Public/UI/PlayerStatsWidget.h` — widget header
- `Source/MyProject/Private/UI/PlayerStatsWidget.cpp` — widget implementation

## Notes for orchestrator

- Phase 1 and Phase 2 are strictly sequential (Phase 2 depends on the subsystem from Phase 1).
- The project uses the `Enhanced Input` plugin — do not modify input bindings.
- Review should check for proper `UPROPERTY`/`UFUNCTION` specifiers and consistent naming.
