#!/usr/bin/env node
/**
 * Tests for lint-cpp-diff.mjs rules.
 *
 * Each rule has:
 * - Cases it MUST catch (true positives)
 * - Cases it MUST allow (true negatives / edge cases)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkLines } from './lint-cpp-diff.mjs';

/**
 * Assert that the linter catches this line (produces at least one issue).
 */
function expectCatch(line, description) {
  const issues = checkLines([line], 'Test.h');
  assert.ok(issues.length > 0, `Should catch: ${description}\n  Line: ${line}`);
}

/**
 * Assert that the linter does NOT flag this line.
 */
function expectAllow(line, description) {
  const issues = checkLines([line], 'Test.h');
  assert.equal(issues.length, 0,
    `Should allow: ${description}\n  Line: ${line}\n  Got: ${issues.join('\n       ')}`);
}

// --- Rule 0: Non-ASCII characters ---

describe('Rule 0: Non-ASCII characters', () => {
  it('catches less-than-or-equal in comment', () => {
    expectCatch('\t// capacity ≤ population', 'less-than-or-equal in comment');
  });
  it('catches en dash in comment', () => {
    expectCatch('\t// keep tiny – only counting', 'en dash in comment');
  });
  it('catches em dash in comment', () => {
    expectCatch('\t// keep tiny — only counting', 'em dash in comment');
  });
  it('catches non-breaking hyphen in identifier-like context', () => {
    expectCatch('\t// I‑th element', 'non-breaking hyphen');
  });
  it('catches smart double quotes', () => {
    expectCatch('\t// “small”', 'smart double quotes');
  });
  it('catches smart single quote (apostrophe)', () => {
    expectCatch("\t// we’re only counting", 'smart single quote');
  });
  it('catches horizontal ellipsis', () => {
    expectCatch('\t// 1 … P.NumArchetypes', 'horizontal ellipsis');
  });
  it('catches almost-equal-to', () => {
    expectCatch('\t// (coord mod 100) ≈ 50', 'almost-equal-to');
  });
  it('catches not-equal-to', () => {
    expectCatch('\t// X ≠ Y', 'not-equal-to');
  });
  it('catches greater-than-or-equal', () => {
    expectCatch('\t// N ≥ 0', 'greater-than-or-equal');
  });
  it('catches section sign', () => {
    expectCatch('\t// Vision §3 reference', 'section sign');
  });
  it('catches multiplication sign', () => {
    expectCatch('\t// EntityConfig × Stack', 'multiplication sign');
  });
  it('catches middle dot', () => {
    expectCatch('\t// A · B', 'middle dot');
  });
  it('catches non-breaking space', () => {
    expectCatch('int32 X = 0;', 'non-breaking space');
  });
  it('catches glyphs outside comments (in code)', () => {
    expectCatch('if (X ≤ Y) { return; }', 'less-than-or-equal in code');
  });
  it('catches an unmapped non-ASCII char with generic message', () => {
    expectCatch('// emoji \u{1F600} sneaks in', 'unmapped non-ASCII char');
  });
  it('reports the ASCII replacement in the issue text', () => {
    const issues = checkLines(['// capacity ≤ population'], 'Test.h');
    assert.ok(
      issues.some(s => s.includes("'<='")),
      `Issue should mention the ASCII replacement '<=': ${issues.join(' | ')}`
    );
  });

  it('allows a pure-ASCII comment', () => {
    expectAllow('// keep tiny - only counting', 'pure-ASCII comment');
  });
  it('allows pure-ASCII code', () => {
    expectAllow('int32 X = 0;', 'pure-ASCII code');
  });
});

// --- Rule: Generated header paths ---

describe('Rule: Generated header paths', () => {
  it('catches path in generated header include', () => {
    expectCatch('#include "Source/MyProject/MyClass.generated.h"', 'path in generated header');
  });
  it('catches relative path in generated header include', () => {
    expectCatch('#include "Public/MyClass.generated.h"', 'relative path in generated header');
  });
  it('catches angle-bracket path in generated header', () => {
    expectCatch('#include <MyProject/MyClass.generated.h>', 'angle-bracket path');
  });

  it('allows bare generated header filename', () => {
    expectAllow('#include "MyClass.generated.h"', 'bare generated header filename');
  });
  it('allows non-generated header with path', () => {
    expectAllow('#include "Components/SceneComponent.h"', 'non-generated header with path');
  });
  it('allows comment mentioning generated header', () => {
    expectAllow('// #include "Bad/Path.generated.h"', 'comment mentioning generated header');
  });
});

// --- Rule 1: East-const ---

describe('Rule 1: East-const', () => {
  it('catches const FVector& parameter', () => {
    expectCatch('void Foo(const FVector& V);', 'const FVector& parameter');
  });
  it('catches const FString& local', () => {
    expectCatch('const FString& Name = TEXT("hello");', 'const FString& local');
  });
  it('catches const int32* pointer', () => {
    expectCatch('const int32* Ptr = nullptr;', 'const int32* pointer');
  });
  it('catches indented const param', () => {
    expectCatch('    const FTransform& Transform,', 'indented const param');
  });

  it('allows correct east-const reference', () => {
    expectAllow('void Foo(FVector const& V);', 'correct east-const reference');
  });
  it('allows correct east-const local', () => {
    expectAllow('FString const& Name = TEXT("hello");', 'correct east-const local');
  });
  it('allows correct east-const pointer', () => {
    expectAllow('int32 const* Ptr = nullptr;', 'correct east-const pointer');
  });
  it('allows constexpr keyword', () => {
    expectAllow('constexpr int32 MaxSize = 100;', 'constexpr keyword');
  });
  it('allows consteval keyword', () => {
    expectAllow('consteval int32 Value = 42;', 'consteval keyword');
  });
  it('allows comment line', () => {
    expectAllow('// const FVector& is wrong', 'comment line');
  });
  it('allows preprocessor line', () => {
    expectAllow('#define MACRO const int& x', 'preprocessor line');
  });
  it('allows const pointer to const', () => {
    expectAllow('FSlateBrush const* const Result = nullptr;', 'const pointer to const');
  });
});

// --- Rule 2: const_cast banned ---

describe('Rule 2: const_cast banned', () => {
  it('catches const_cast usage', () => {
    expectCatch('const_cast<FString*>(Ptr);', 'const_cast usage');
  });
  it('catches const_cast in assignment', () => {
    expectCatch('    auto* Mutable = const_cast<FMyClass*>(Obj);', 'const_cast in assignment');
  });

  it('allows comment mentioning const_cast', () => {
    expectAllow('// const_cast is banned', 'comment mentioning const_cast');
  });
});

// --- Rule 3: Anonymous namespaces ---

describe('Rule 3: Anonymous namespaces', () => {
  it('catches anonymous namespace opening', () => {
    expectCatch('namespace {', 'anonymous namespace opening');
  });
  it('catches anonymous namespace no space', () => {
    expectCatch('namespace{', 'anonymous namespace no space');
  });
  it('catches indented anonymous namespace', () => {
    expectCatch('    namespace {', 'indented anonymous namespace');
  });
  it('catches Allman-style anonymous namespace (brace on next line)', () => {
    const issues = checkLines(['namespace', '{'], 'Test.cpp');
    assert.ok(
      issues.some(s => s.includes('Anonymous namespace')),
      `Should catch Allman-style anonymous namespace. Got: ${issues.join(' | ')}`
    );
  });
  it('catches Allman-style with blank line between', () => {
    const issues = checkLines(['namespace', '', '{'], 'Test.cpp');
    assert.ok(
      issues.some(s => s.includes('Anonymous namespace')),
      `Should catch Allman with blank line. Got: ${issues.join(' | ')}`
    );
  });
  it('catches anonymous namespace with block comment between', () => {
    const issues = checkLines(['namespace /* anon helpers */', '{'], 'Test.cpp');
    assert.ok(
      issues.some(s => s.includes('Anonymous namespace')),
      `Should catch namespace with block comment. Got: ${issues.join(' | ')}`
    );
  });

  it('allows named namespace', () => {
    expectAllow('namespace UE::ResortModule {', 'named namespace');
  });
  it('allows nested named namespace', () => {
    expectAllow('namespace UE::ResortModule::Private {', 'nested named namespace');
  });
  it('allows Allman-style named namespace (brace on next line)', () => {
    const issues = checkLines(['namespace UE::ResortModule', '{'], 'Test.cpp');
    assert.equal(
      issues.filter(s => s.includes('Anonymous namespace')).length, 0,
      `Should allow Allman-style named namespace. Got: ${issues.join(' | ')}`
    );
  });
  it('allows commented anonymous namespace', () => {
    expectAllow('// namespace {', 'commented anonymous namespace');
  });
  it('allows anonymous namespace inside block comment', () => {
    const issues = checkLines(['/* example:', 'namespace', '{', '*/'], 'Test.cpp');
    assert.equal(
      issues.filter(s => s.includes('Anonymous namespace')).length, 0,
      `Should allow anonymous namespace inside block comment. Got: ${issues.join(' | ')}`
    );
  });
});

// --- Rule 4: Greedy captures ---

describe('Rule 4: Greedy captures', () => {
  it('catches [&] with params', () => {
    expectCatch('auto Lambda = [&](int32 X) { return X; };', '[&] with params');
  });
  it('catches [=] with params', () => {
    expectCatch('auto Lambda = [=](int32 X) { return X; };', '[=] with params');
  });
  it('catches [&] no-arg lambda', () => {
    expectCatch('auto Lambda = [&] { DoThing(); };', '[&] no-arg lambda');
  });
  it('catches [=] no-arg lambda', () => {
    expectCatch('auto Lambda = [=] { DoThing(); };', '[=] no-arg lambda');
  });

  it('allows explicit captures', () => {
    expectAllow('auto Lambda = [this, &Name](int32 X) { return X; };', 'explicit captures');
  });
  it('allows init capture', () => {
    expectAllow('auto Lambda = [Self = this]() { Self->Do(); };', 'init capture');
  });
  it('allows braced init (not a lambda)', () => {
    expectAllow('TArray<int32> Arr = {1, 2, 3};', 'braced init (not a lambda)');
  });
  it('allows comment', () => {
    expectAllow('// [&] is bad', 'comment');
  });
});

// --- Rule 5: Raw new ---

describe('Rule 5: Raw new', () => {
  it('catches raw new FMyClass', () => {
    expectCatch('FMyClass* Obj = new FMyClass();', 'raw new FMyClass');
  });
  it('catches raw new in return', () => {
    expectCatch('return new FWidget(Args);', 'raw new in return');
  });
  it('catches raw new without parens', () => {
    expectCatch('    auto* Thing = new FBigThing;', 'raw new without parens');
  });

  it('allows NewObject', () => {
    expectAllow('UMyObject* Obj = NewObject<UMyObject>(this);', 'NewObject');
  });
  it('allows MakeShared', () => {
    expectAllow('auto Ptr = MakeShared<FThing>();', 'MakeShared');
  });
  it('allows MakeUnique', () => {
    expectAllow('auto Ptr = MakeUnique<FThing>();', 'MakeUnique');
  });
  it('allows CreateDefaultSubobject', () => {
    expectAllow('auto* Sub = CreateDefaultSubobject<UComp>(TEXT("Comp"));', 'CreateDefaultSubobject');
  });
  it('allows variable named New-something', () => {
    expectAllow('int32 NewCount = OldCount + 1;', 'variable named New-something');
  });
  it('allows comment', () => {
    expectAllow('// new FThing is wrong', 'comment');
  });
  it('allows function with New in name', () => {
    expectAllow('void OnNewMember();', 'function with New in name');
  });
  it('allows new inside TEXT macro', () => {
    expectAllow('checkf(Ptr, TEXT("Received nullptr for new BuildableSaveData"));', 'new inside TEXT macro');
  });
  it('allows new inside UE_LOG string', () => {
    expectAllow('UE_LOG(LogResort, Error, TEXT("Failed to create new Instance"));', 'new inside UE_LOG string');
  });
});

// --- Rule 6: Multiple declarations ---

describe('Rule 6: Multiple declarations', () => {
  it('catches two ints on one line', () => {
    expectCatch('int32 X, Y;', 'two ints on one line');
  });
  it('catches two floats, one initialised', () => {
    expectCatch('float A, B = 0.f;', 'two floats, one initialised');
  });

  it('allows single declaration', () => {
    expectAllow('int32 X;', 'single declaration');
  });
  it('allows function parameters', () => {
    expectAllow('void Foo(int32 X, int32 Y);', 'function parameters');
  });
  it('allows for-loop init', () => {
    expectAllow('for (int32 I = 0, N = Arr.Num(); I < N; ++I)', 'for-loop init');
  });
  it('allows template with comma', () => {
    expectAllow('TMap<FString, int32> Map;', 'template with comma');
  });
  it('allows template parameter list', () => {
    expectAllow('template<typename T, typename = std::enable_if_t<std::is_base_of_v<USceneComponent, T>>>', 'template parameter list');
  });
});

// --- Regression: Block comments ---

describe('Regression: Block comments', () => {
  it('allows block comment continuation (east-const)', () => {
    expectAllow('* PreProcessors run exclusively when a new Buildable is created.', 'block comment continuation');
  });
  it('allows block comment with new in prose (raw-new)', () => {
    expectAllow('* and choose to start a new Framework or return to their current one.', 'block comment with new in prose');
  });
});

// --- Rule 7: Uninitialised TSharedRef ---

describe('Rule 7: Uninitialised TSharedRef', () => {
  it('catches uninitialised TSharedRef field', () => {
    expectCatch('TSharedRef<FMyThing> Thing;', 'uninitialised TSharedRef field');
  });
  it('catches indented uninitialised TSharedRef', () => {
    expectCatch('    TSharedRef<SWidget> Widget;', 'indented uninitialised TSharedRef');
  });

  it('allows initialised with MakeShared', () => {
    expectAllow('TSharedRef<FMyThing> Thing = MakeShared<FMyThing>();', 'initialised with MakeShared');
  });
  it('allows brace-initialised', () => {
    expectAllow('TSharedRef<FMyThing> Thing{MakeShared<FMyThing>()};', 'brace-initialised');
  });
  it('allows TSharedPtr uninitialised', () => {
    expectAllow('TSharedPtr<FMyThing> Thing;', 'TSharedPtr is fine uninitialised');
  });
  it('allows comment', () => {
    expectAllow('// TSharedRef<FMyThing> Thing;', 'comment');
  });
  it('allows function parameter', () => {
    expectAllow('void Foo(TSharedRef<FMyThing> Thing);', 'function parameter (has parens)');
  });
});

// --- Rule 8: IILE ---

describe('Rule 8: IILE', () => {
  it('catches IILE with return type', () => {
    expectCatch('auto X = [this]() -> int32 { return 42; }();', 'IILE with return type');
  });
  it('catches IILE minimal', () => {
    expectCatch('auto X = []() { return 42; }();', 'IILE minimal');
  });

  it('allows stored lambda (not invoked)', () => {
    expectAllow('auto Lambda = [this]() { return 42; };', 'stored lambda (not invoked)');
  });
  it('allows regular function call', () => {
    expectAllow('Callback();', 'regular function call');
  });
});
