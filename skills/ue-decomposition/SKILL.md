---
name: ue-decomposition
description: Use when reviewing Unreal Engine C++ code for decomposition opportunities. UE-specific concerns — UPROPERTY chain visibility, GC rooting, unity build inlining, and UE responsibility group types. Compose with general-decomposition for universal structural checks.
---

# UE Decomposition Domain Knowledge

UE-specific decomposition concerns that go beyond general structural analysis. These are truths about Unreal Engine's ownership model, build system, and macro conventions.

## UE Responsibility Group Types

Beyond general responsibility groups (see general-decomposition), these are UE-specific seams:

- A `UCLASS` or `USTRUCT` that could live in its own header/implementation
- A group of `UFUNCTION(BlueprintCallable)` or `UFUNCTION(Server)` handlers forming a distinct API surface
- Processor/observer logic (`FMassEntityQuery` execution, delegate bindings) serving a different subsystem than the file's primary concern

## Extraction Is Free

Do not withhold extraction suggestions due to perceived function-call overhead:

- **Unity builds** — UE amalgamates related TUs. The compiler sees callers and callees together. Small helpers inline automatically.
- **`FORCEINLINE`** — if profiling disagrees, adding it to a hot helper is trivial. Default to maximum readability.

Always propose the extraction. Never self-censor because "it might be slower."

## Lifetime-Informed Decomposition

### Reasons FOR splitting

- A function group operates on data it receives by reference — no pointer-ownership responsibilities. Clear parameter contract.
- A nested helper class holds no `UObject*` members — could be a standalone `F`-prefixed struct with value semantics.
- A file mixes long-lived state management (component members, cached handles) with short-lived computational helpers.

### Reasons AGAINST splitting

- A class's `UPROPERTY()` members and the methods managing their lifetimes would end up in different files. Reviewers need the full ownership picture in one place.
- Splitting forces passing raw pointers across file boundaries where current code uses direct member access with clear ownership.
- Thread synchronisation (locks, atomics, game-thread checks) guards methods that would span multiple files. Lock scope becomes non-obvious.
- A helper captures `this` or member references in lambdas posted to async work. Moving it makes capture lifetime harder to audit.

When a decomposition has both arguments for and against, weigh them explicitly. If the lifetime risk outweighs the organisational benefit, do not propose the split.
