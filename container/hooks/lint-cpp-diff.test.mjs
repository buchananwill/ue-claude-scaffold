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

  it('allows named namespace', () => {
    expectAllow('namespace UE::ResortModule {', 'named namespace');
  });
  it('allows nested named namespace', () => {
    expectAllow('namespace UE::ResortModule::Private {', 'nested named namespace');
  });
  it('allows commented anonymous namespace', () => {
    expectAllow('// namespace {', 'commented anonymous namespace');
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
