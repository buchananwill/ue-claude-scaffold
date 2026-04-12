---
name: ue-safety
description: Use when reviewing Unreal Engine C++ code for memory safety, pointer lifecycles, GC interactions, thread safety, and MoveTemp correctness. Domain knowledge for safety-focused review.
---

# UE Safety Domain Knowledge

What to look for when reviewing UE C++ for runtime safety. These bugs compile but crash, corrupt, race, or leak.

## Memory Safety

- **Dangling `TObjectPtr<>`** — pointer surviving past its outer's lifetime. Check: is there a `UPROPERTY()` to establish a GC root?
- **Raw `UObject*` across GC boundaries** — cached across frame boundaries or async callbacks can dangle after GC. Must be `TWeakObjectPtr` or `UPROPERTY() TObjectPtr<>`.
- **Smart pointer cycles** — `TSharedPtr` circular references without a `TWeakPtr` break.
- **Stack references escaping scope** — lambdas capturing locals by reference, then stored or posted to another thread.
- **`TSharedRef` misuse** — null-checking (it cannot be null), default-constructing without a valid object.
- **Array/container invalidation** — holding a reference into a `TArray` across an operation that can reallocate (Add, Insert, SetNum, Reserve).
- **`std::function` in Unreal containers** — `TArray`, `TMap`, `TSet` may relocate elements via raw `FMemory::Memcpy`, bypassing move/copy constructors. `std::function` has non-trivial move semantics; raw memcpy corrupts it. Flag as **BLOCKING**. Fix: use `TFunction`.

## Garbage Collection

- **Missing `UPROPERTY()` on `TObjectPtr` members** — GC doesn't know about pointers unless marked with UPROPERTY(), will collect the object.
- **`NewObject<>` result not rooted** — if not stored in a `UPROPERTY` or added to the root set, GC can collect it before use.
- **Accessing `UObject` after `ConditionalBeginDestroy`** — check `IsValid()` / `IsValidLowLevel()` before use in deferred contexts.
- **`AddReferencedObjects` correctness** — non-UObject class holding UObject pointers must implement this or use `FGCObject`.

## Thread Safety

- **Shared state mutations without synchronization** — writing from multiple threads without `FCriticalSection`, `FRWLock`, or atomics.
- **Game thread assumptions** — reading `UObject` state from a background thread without ensuring game-thread-only access.
- **Async callback captures** — lambdas posted to `AsyncTask` or `FRunnable` that capture `this` or member references — the object may be destroyed before the callback runs.

## Move Semantics

- **`MoveTemp` on const** — `MoveTemp(ConstRef)` silently copies. The move is a lie.
- **Use after move** — any read of a moved-from variable (except reassignment or destruction).
- **Unnecessary `MoveTemp`** — on trivially-copyable types (`int32`, `float`, `FVector`), or on prvalues already being moved.
- **`MoveTemp` on `UPROPERTY`** — moving out of a property that GC may still reference.

## Ownership Analysis

Analyse ownership models across every boundary in the design — who creates, who holds, who destroys. Identify ambiguous or shared ownership that lacks explicit policy.

## Destruction Ordering

Consider destruction ordering — subsystem teardown, world cleanup, editor hot-reload. Will the design survive these lifecycle events without crashes or leaks?

## Review Discipline

For each changed function, constructor, or callback:
- **Trace pointer lifetimes**: where does the pointer come from, where is it stored, what owns it, when does the owner die?
- **Check GC rooting**: every `TObjectPtr<UObject>` member must be `UPROPERTY()`. No raw pointer fields.
- **Check thread context**: is this called from game thread only, or can it run on background threads?
- **Check move correctness**: every `MoveTemp` call should actually move, and the moved-from variable should not be used after.

Every finding must include the specific code path that leads to the problem. "Might be unsafe" is not a finding.
