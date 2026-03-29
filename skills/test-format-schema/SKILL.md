---
name: test-format-schema
description: Use when writing UE5 automation tests in the Piste Perfect project. Defines test naming, flags, file structure, guard macros, and the standard test pattern template.
---

# Test Format Schema

Structural conventions for UE5 automation tests in this project.

## Naming

- Test name format: `Resort.<System>.<Feature>.<TestName>`
- Class name with `F` prefix: `FBuildableMemoryOps_ResetRootIndexCache_RebuildsFromTree`

## Test Flags

```cpp
static constexpr EAutomationTestFlags G<Category>TestFlags =
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter;
```

## File Structure

- Copyright header: `// Copyright 2025 Shipborn Software Solutions, All Rights Reserved`
- Guard: `#if WITH_DEV_AUTOMATION_TESTS` / `#endif // WITH_DEV_AUTOMATION_TESTS`
- No `#pragma once` in `.cpp` test files
- Test files in `Source/PistePerfect/Private/Tests/` with subdirectories per category
- Helper/mock files in `Tests/Mock/` or `Tests/<Category>/Mock/`
- Namespaces: `Resort::<Domain>::Test` for test utilities

## Test Pattern

```cpp
#if WITH_DEV_AUTOMATION_TESTS

#include "Tests/Mock/<Category>TestHelpers.h"

// Do NOT use `using namespace` — unity builds amalgamate TUs,
// causing name collisions. Use explicit qualification instead.
namespace Test = Resort::<Domain>::Test;

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    F<ClassName>,
    "Resort.<System>.<Feature>.<TestName>",
    G<Category>TestFlags)

bool F<ClassName>::RunTest(const FString& /*Parameters*/)
{
    // Arrange
    // Act
    // Assert
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
```
