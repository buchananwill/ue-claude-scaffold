---
name: ue-cpp-style
description: Use when writing or reviewing Unreal Engine C++ code. Authoritative style guide covering naming, formatting, const, ownership, pointers, lambdas, UE vs std choices, reflection macros, and modern C++ usage. Domain knowledge independent of review process.
axis: domain
---

# Unreal Engine C++ Style Guide

These rules merge Epic's official coding standard with modern best practices. When they conflict, the modern practice wins — it produces cleaner, safer code.

## File Header

Every source file (`.h`, `.cpp`) must begin with:

```cpp
// Copyright <year> Shipborn Software Solutions, All Rights Reserved
```

## Naming

- **PascalCase** for all types, functions, member variables, namespaces, enums, enum values.
- **Type prefixes** — enforced by UHT for reflected types:
  - `U` — UObject subclasses (`UActorComponent`)
  - `A` — AActor subclasses (`APlayerController`)
  - `S` — SWidget subclasses (`SCompoundWidget`)
  - `F` — structs and non-UObject classes (`FVector`, `FMyStruct`)
  - `T` — templates (`TArray`, `TSubclassOf`)
  - `I` — abstract interfaces (`IInteractable`)
  - `E` — enums (`EMovementMode`)
  - `C` — concept-alike structs (`CStaticClassProvider`)
  - `b` — booleans (`bIsVisible`, `bHasStarted`)
- **No prefix on file names** — `BuildableActor.cpp`, not `ABuildableActor.cpp`.
- **`Out` prefix** on non-const reference parameters the function writes to.
- **`In` prefix** to disambiguate template parameters from nested aliases.
- **Method names are verbs**: `GetHealth()`, `IsAlive()`, `ApplyDamage()`.
  - Bool-returning functions ask a question: `IsVisible()`, `ShouldUpdate()`, `CanInteract()`.
  - Procedures use strong verb + object: `DestroyWidget()`, `SpawnGuest()`.
- **Macros**: `UE_` prefix, `SCREAMING_SNAKE_CASE` (`UE_LOG`, `UE_AUDIT_IMPORT`).
- **`using` over `typedef`** — supports templates and is clearer for function pointers.

## Indentation and Formatting

A `.clang-format` file at the repository root is the authoritative source. Run `clang-format -i <file>` to auto-fix.

- **Tabs** for all indentation. No spaces.
- **Allman brace style** — opening `{` on a new line, at the same indentation as the scope identifier.
- **All scopes indent** — namespaces, classes, functions, control flow, lambdas.
- **Access modifiers** (`public:`, `private:`, `protected:`) are flush with the `class`/`struct` keyword.

```cpp
// Correct
namespace Resort
{
    class FMyClass
    {
    public:
        void DoWork()
        {
            if (bReady)
            {
                Execute();
            }
        }
    };
}
```

## General Style

- **`nullptr`** always. Never `NULL` or `0` for pointers.
- **Never declare a member field as a reference type.** Member fields must be by value or a smart/UPROPERTY pointer.
- **`GENERATED_BODY()`** only — never `GENERATED_UCLASS_BODY()` or `GENERATED_USTRUCT_BODY()`.
- **`override`** on every virtual override. Use `final` when appropriate.
- **`static_assert`** for compile-time invariants.
- **Strongly-typed `enum class`** — use `ENUM_CLASS_FLAGS()` for bitmask enums with a `None = 0`. Blueprint-exposed enums must be `: uint8`.
- **IWYU** (Include What You Use) — never include `Engine.h` or similarly broad headers. Keep `.h` minimal; heavy includes go in `.cpp`.
- **Generated headers use bare filenames** — `#include "MyClass.generated.h"`, never a directory path. UBT adds the intermediate generated-code directory to the include path automatically. The same applies to other UBT-generated headers (e.g. `.gen.cpp` includes).
- **Avoid `FORCEINLINE`** unless profiling proves it helps. The compiler inlines better.
- **Avoid `mutable`** — it should be rare and well-justified.
- **Never** use `const_cast`. Code must respect const-correctness at all times.
- **Variadic templates** over C-style varargs. Correct: `void Func(T... Args);` — Wrong: `void Func(T Args...);`
- **Self-documenting code over comments.** Don't comment what the code does — rename to make intent obvious. Comment *why* when the reason isn't self-evident.
- **Never return `const` by value** — it inhibits move semantics.
- **`TEXT()` macro** for string literals passed to FString constructors.
- **Default member initializers** in the class body rather than constructor init lists, unless the value depends on constructor arguments.
- **Prefer `enum class` directly as UPROPERTY** — not `TEnumAsByte<>`.
- **Wrap complex boolean expressions** in named locals:
  ```cpp
  const bool bCanFire = bHasAmmo && !bIsReloading && CooldownTimer <= 0;
  ```
- **Prefer params structs** over functions with 5+ parameters.
- **Always use braces and newlines for control flow** — every `if`, `else`, `for`, `while`, and `do` body must use braces on their own lines, even for single statements. No same-line bodies.
  ```cpp
  // Correct
  if (Ptr == nullptr)
  {
      return;
  }

  // Wrong
  if (Ptr == nullptr) return;
  if (Ptr == nullptr)
      return;
  ```

## auto Usage

When the type already appears on the line (Cast<>, constructors, MakeUnique<>, etc.), **prefer `auto` over repeating the type.**

- **Use `auto*`** after `Cast<>` — type is in the template argument. **Never omit the explicit `*`.**
  ```cpp
  auto* const Comp = Cast<UStaticMeshComponent>(Component);
  ```
- **Use `auto&`** when the type is obvious from context.
- **Avoid bare `auto`** when the type isn't visible on the same line.
- **East-const with auto** — `const auto X = Cast<>()` makes X a raw pointer, not const pointee. Use east-const: `auto* const` (const ptr), `auto const*` (ptr to const), `auto const&` (const ref).
- **Structured bindings** (`auto [X, Y] = Func();`) are encouraged in non-reflected code. Use `Tie(X, Y)` for reassignment.

## const — Where It Matters

- **Do**: `const` on pointers/references to const objects, on member functions, on range-for when not mutating: `for (FString const& Str : Array)`.
- **Do**: `const` on return-by-reference: `TArray<FString> const& GetNames() const;`
- **Don't**: `const` on return-by-value — it inhibits move semantics.
- **Nuanced**: `const` on local values and by-value params is optional. Consistency within a file matters most.
- **East-const preferred**: place `const` on the right. `T* const` (const pointer), `T const*` (pointer to const), `T const&` (const reference).

## Ownership and Pointers

### Decision Tree

```
Is it a UObject?
├─ Member field?                        → TObjectPtr<UMyClass> (always — no exceptions)
├─ Function param, null is valid?       → UMyClass* (raw pointer)
├─ Function param, null is a bug?       → UMyClass& (reference)
├─ Cached ref that might get GC'd?      → TWeakObjectPtr<UMyClass>
└─ Asset reference (lazy load)?         → TSoftObjectPtr<UMyClass> / FSoftObjectPath

Is it a non-UObject on the heap?
├─ Single owner?                        → TUniquePtr<FMyStruct> via MakeUnique<>()
├─ Shared ownership?                    → TSharedPtr<FMyStruct> via MakeShared<>()
├─ Non-owning observer of shared?       → TWeakPtr<FMyStruct>
└─ Stack/member by value?               → Use the value directly
```

### TObjectPtr — Member Fields

All member pointers to UObject types use `TObjectPtr<>`. No exceptions:

```cpp
UPROPERTY()
TObjectPtr<UStaticMeshComponent> MeshComponent;
```

### TSharedRef — Non-Nullable, Must Not Be Moved

`TSharedRef` **must not be moved** — `MoveTemp(TSharedRef)` compiles but triggers an ensure at runtime. Pass as `TSharedRef<T> const&` (read) or `TSharedRef<T>&` (re-seat). Never pass by value.

Avoid as a container value type — any operation that default-constructs or moves elements ensures. Safe only when every insertion supplies a pre-constructed ref and no default-construction path exists.

```cpp
// WRONG — triggers ensure
TSharedRef<FMyData> Moved = MoveTemp(Original);

// CORRECT — copy (increments ref count)
TSharedRef<FMyData> Copy = Original;

// WRONG — FindOrAdd default-constructs, then move-assigns
TMap<FName, TSharedRef<FMyData>> Map;
Map.FindOrAdd(Key) = MakeShared<FMyData>();  // ensure!

// CORRECT — use TSharedPtr in containers
TMap<FName, TSharedPtr<FMyData>> Map;
```

### Never TSharedPtr\<UObject\>

UObjects are GC-managed, not shared-pointer-managed. Never wrap UObjects in TSharedPtr.

### Lambda Captures and Pointer Safety

Deferred lambdas (delegates, timers, async) must use `CreateWeakLambda` / `CreateSPLambda`, or capture `TWeakObjectPtr` and validate:

```cpp
// DANGEROUS — raw pointer capture in deferred lambda; MyActor might be GC'd
TWeakObjectPtr<AActor> WeakActor = GetOwner();
GetWorld()->GetTimerManager().SetTimer(Handle, [WeakActor]()
{
    if (AActor* Actor = WeakActor.Get())
    {
        Actor->DoThing();
    }
}, 1.0f, false);
```

### Anti-patterns

- Raw `UObject*` member fields — always `TObjectPtr<>`
- Raw `new`/`delete` for non-UObjects — always `MakeUnique`/`MakeShared`
- Storing `TObjectPtr<>` without `UPROPERTY()` — GC can't see it
- Storing `TObjectPtr<>` AT ALL in a non-reflected (non-USTRUCT or non-UCLASS) type — GC can't see it
- `TSharedPtr<UMyObject>` — never wrap UObjects in shared pointers
- `TWeakObjectPtr` for guaranteed-lifetime refs — unnecessary overhead

## Lambdas

- **Explicit captures** — never `[&]` or `[=]`. Prefer `[this]` over `[=]`.
- **Deferred lambdas**: use `CreateWeakLambda` / `CreateSPLambda`, or capture `TWeakObjectPtr` and validate.
- **Keep lambdas short** — a couple statements max when inline in an expression.
- **Explicit return types** on large lambdas.
- **AVOID Immediately Invoked Lambda Expressions (IILE).** They are an anti-pattern and suggest the overall design needs another look. A last resort only when all alternatives are less readable.

## Namespaces

- Namespaces are supported for non-reflected code (free functions, utilities, constants).
- **Cannot** wrap `UCLASS`, `USTRUCT`, `UENUM` — UHT does not support it.
- Use `Private` sub-namespace for implementation details: `UE::Audio::Private::`.
- Macros cannot live in namespaces — use `UE_` prefix instead.
- **Never use anonymous namespaces** (`namespace { ... }`) — UE unity builds merge multiple `.cpp` files into one translation unit, causing symbol collisions between identically-named functions in different files. Use a named namespace for file-local helpers instead.
- **Never use `using namespace`** in `.cpp` files — unity builds amalgamate TUs, causing name collisions across files.

## Standard Library vs UE

Epic's guidance: "prefer the option which gives superior results."

### Containers

- **`TArray`, `TMap`, `TSet`** — required for `UPROPERTY`. Note: UE containers use `FMemory::Realloc` on their backing buffer, bypassing constructors and destructors on existing elements. Non-trivially-copyable types (e.g. `std::function`, `std::atomic`) are unsafe in UE containers.
- **`std::vector`** — acceptable for internal non-reflected code when you need correct handling of immovable/non-copyable types.
- Never call `.begin()`/`.end()` directly on UE containers — they exist only for implicit range-for. Bridge to std algorithms via `GetData()`/`GetNum()` or a `std::span` adapter.

### Callables — `TFunction`, Never `std::function`

**`std::function` — NEVER.** `TArray` growth uses `FMemory::Realloc` on the backing buffer, bypassing all constructors and destructors. MSVC's `std::function` SBO implementation stores self-referential pointers that become stale after realloc, causing use-after-free crashes on invocation. This applies even to `std::function` stored as a member of a struct that ends up in a UE container.

**Use `TFunction` for stored callables and `TFunctionRef` for non-owning parameter passing.** `std::function` has no safe use in this codebase.

### Atomics — `std::atomic` Has Restrictions

`std::atomic` has deleted copy/move constructors. `FMemory::Realloc` bypasses these during growth (technically UB), and within-buffer operations like `RemoveAt`/`Insert` will fail to compile. `std::atomic` remains correct for **standalone fields** in native C++ classes where the variable's address never changes. For per-element counts in arrays, use plain `int32` and serialize mutations via `TMpscQueue`.

### Algorithms

Prefer `std::sort` and `<algorithm>` — they outperform UE equivalents. Bridge via `std::span` adapter:

```cpp
auto AsSpan(auto& Container)
{
    return std::span(GetData(Container), GetNum(Container));
}
std::sort(AsSpan(MyArray).begin(), AsSpan(MyArray).end(), Predicate);
```

If bridging feels heavyweight, `TArray::Sort()` with a predicate is acceptable.

### Quick Reference Table

| Use `std::`                              | Use UE                                        |
|------------------------------------------|-----------------------------------------------|
| `std::atomic` (standalone fields only)   | `TArray`, `TMap`, `TSet` (for UPROPERTY)      |
| `std::sort`, `<algorithm>`               | `TFunction` / `TFunctionRef` (not std::function) |
| `std::numeric_limits`                    | `FString`, `FName`, `FText`                   |
| `std::unique_ptr` (= TUniquePtr)         | `TSharedPtr` (UE ecosystem compat)            |
| `std::tuple` (TVariant/TTuple incomplete)| `TOptional`, `TDelegate`, `MoveTemp`          |
| `std::string` at interop boundaries only | `TObjectPtr`, `TWeakObjectPtr`, `TSoftObjectPtr` |

### UE5Coro Aggregate Awaiter Hazard

`WhenAll`, `WhenAny`, and `Race` must be **constructed before the work they await can complete**. Construct on the game thread before dispatching signals or tasks into the Mass/task system. If an input coroutine completes before the aggregate is wired up, a self-deadlock occurs via non-recursive mutex re-acquisition.

```cpp
// SAFE — construct aggregate before processors can interleave
TArray<UE5Coro::TCoroutine<>> Awaiters;
for (auto& Launcher : Launchers) { Awaiters.Add(Launcher(Dispatcher)); }
auto Completion = UE5Coro::WhenAll(Awaiters);  // wire up now
co_await UE5Coro::Async::MoveToTask();
co_await Completion;

// UNSAFE — TOCTOU: a coroutine may complete during construction
co_await UE5Coro::Async::MoveToTask();
co_await UE5Coro::WhenAll(Awaiters);
```

## Modern C++ Features

UE compiles with C++20. Encouraged in non-reflected code.

- **`if constexpr`** — compile-time branching in templates. Eliminates SFINAE in many cases.
- **Concepts and `requires`** — prefer over `TEnableIf`/SFINAE.
- **`[[nodiscard]]`** — on functions where ignoring the return is almost certainly a bug.
- **Designated initializers** — fine for POD/aggregate initialization in non-reflected code.
- **Three-way comparison** (`auto operator<=>(…) = default`) — available but rarely needed.
- **Ranges** — available via `std::span` adapter over UE containers.
- **`consteval`** — forces compile-time evaluation.
- **`constinit`** — ensures static initialization at compile time without making the variable const.
- **Float literals in generic code** — use `0` and `1` instead of `0.0f` and `1.0f` to avoid overload ambiguity with LWC double APIs.
- **Integer types** — `int` is safe on all UE platforms (guaranteed >= 32 bits). Reserve `int32` for `UPROPERTY` and serialized values to signal explicit width intent.

## UE Reflection (UCLASS / USTRUCT / UPROPERTY / UFUNCTION)

### Class Layout

```cpp
UCLASS()
class MYMODULE_API AMyActor : public AActor
{
    GENERATED_BODY()

public:
    AMyActor();

protected:
    virtual void BeginPlay() override;

private:
    UPROPERTY()
    TObjectPtr<USceneComponent> Root;
};
```

- `GENERATED_BODY()` only — never `GENERATED_UCLASS_BODY()` or `GENERATED_USTRUCT_BODY()`.
- Access specifiers go AFTER `GENERATED_BODY()`.
- Public interface first, then protected, then private.
- UHT does not support namespaces around reflected types — reflected classes must be at global scope.

### UPROPERTY Exposure Specifiers — Use the Narrowest Scope

| Specifier          | When to use                                              |
|--------------------|----------------------------------------------------------|
| `EditAnywhere`     | Designer needs to tune per-instance and per-class        |
| `EditDefaultsOnly` | Should be consistent across all instances                |
| `EditInstanceOnly` | Varies per placement but shouldn't change the archetype  |
| `VisibleAnywhere`  | Computed/code-managed value the designer should see      |

All `UPROPERTY` pointers to UObject types must use `TObjectPtr<>`:
```cpp
UPROPERTY()
TObjectPtr<UStaticMeshComponent> MeshComp;  // Correct

UPROPERTY()
UStaticMeshComponent* MeshComp;  // Wrong — use TObjectPtr
```

Boolean properties: use `bool bFlag` by default. Use `uint8 bFlag : 1` bitfields when you have many boolean flags and memory layout matters (replicated structs, Mass fragments).

### UFUNCTION Specifiers

| Specifier                     | When to use                                  |
|-------------------------------|----------------------------------------------|
| `BlueprintCallable`           | Can be called from Blueprint                 |
| `BlueprintPure`               | No side effects, no exec pin — use for getters |
| `BlueprintImplementableEvent` | Declared in C++, implemented in Blueprint    |
| `BlueprintNativeEvent`        | C++ default, overridable in Blueprint        |
| `CallInEditor`                | Callable from details panel button in editor |

### USTRUCT

```cpp
USTRUCT(BlueprintType)
struct FMyData
{
    GENERATED_BODY()

    UPROPERTY(EditAnywhere)
    FString Name;

    UPROPERTY(EditAnywhere)
    int32 Count = 0;
};
```

Default member initializers in the struct body. No constructors needed for simple data structs — use designated initializers.

### UENUM

```cpp
UENUM(BlueprintType)
enum class EGuestState : uint8
{
    Idle    UMETA(DisplayName = "Idle"),
    Walking UMETA(DisplayName = "Walking"),
    Skiing  UMETA(DisplayName = "Skiing"),
};
```

Blueprint-exposed enums must be `: uint8`. Use `UMETA(DisplayName = "…")` for editor-friendly names.

## Slate Styling

- **No magic numbers in Slate code.** Every padding, margin, width, height, and gap must reference a named token or constant.
- Use `StyleKeys::PaddingAmount(EUiSize)` for padding and margins. Scale relative to 20px base: XSmall (12.8), Small (16), Medium (20), Large (24), XLarge (30), XXLarge (40).
- Use named constants in `StyleKeys` for fixed dimensions. Current constants: `ButtonSlotGap` (4), `NarrowDialogWidth` (400), `StandardDialogWidth` (800).
- If no token exists for a value, create one in `StyleThemeKeys.h` — never use a literal.
- Use `ComposeDefaultTableSetup()` from `TableSetupHelpers.h` for standard table style composition. Override only what differs via `FTableSetupParams` designated initializers.
