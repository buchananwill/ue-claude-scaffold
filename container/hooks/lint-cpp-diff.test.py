#!/usr/bin/env python3
"""
Tests for lint-cpp-diff.py rules.

Each rule has:
- Cases it MUST catch (true positives)
- Cases it MUST allow (true negatives / edge cases)
"""

import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from importlib import import_module

# Import the module with hyphens in its name
import importlib.util
spec = importlib.util.spec_from_file_location("lint", os.path.join(os.path.dirname(__file__), "lint-cpp-diff.py"))
lint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lint)

check_lines = lint.check_lines

PASS = 0
FAIL = 0


def expect_catch(rule_name: str, line: str, description: str):
    """Assert that the linter catches this line."""
    global PASS, FAIL
    issues = check_lines([line], "Test.h")
    if issues:
        PASS += 1
    else:
        FAIL += 1
        print(f"  MISS [{rule_name}] Should catch: {description}")
        print(f"        Line: {line}")


def expect_allow(rule_name: str, line: str, description: str):
    """Assert that the linter does NOT flag this line."""
    global PASS, FAIL
    issues = check_lines([line], "Test.h")
    if not issues:
        PASS += 1
    else:
        FAIL += 1
        print(f"  FALSE POS [{rule_name}] Should allow: {description}")
        print(f"        Line: {line}")
        for i in issues:
            print(f"        Got: {i}")


# ─── Rule 1: East-const ─────────────────────────────────────────────────────

print("Rule 1: East-const")

expect_catch("east-const", "void Foo(const FVector& V);", "const FVector& parameter")
expect_catch("east-const", "const FString& Name = TEXT(\"hello\");", "const FString& local")
expect_catch("east-const", "const int32* Ptr = nullptr;", "const int32* pointer")
expect_catch("east-const", "    const FTransform& Transform,", "indented const param")

expect_allow("east-const", "void Foo(FVector const& V);", "correct east-const reference")
expect_allow("east-const", "FString const& Name = TEXT(\"hello\");", "correct east-const local")
expect_allow("east-const", "int32 const* Ptr = nullptr;", "correct east-const pointer")
expect_allow("east-const", "constexpr int32 MaxSize = 100;", "constexpr keyword")
expect_allow("east-const", "const_cast<FString*>(Ptr);", "const_cast keyword")
expect_allow("east-const", "// const FVector& is wrong", "comment line")
expect_allow("east-const", "#define MACRO const int& x", "preprocessor line")
expect_allow("east-const", "FSlateBrush const* const Result = nullptr;", "const pointer to const")

# ─── Rule 2: Greedy captures ────────────────────────────────────────────────

print("Rule 2: Greedy captures")

expect_catch("greedy-capture", "auto Lambda = [&](int32 X) { return X; };", "[&] with params")
expect_catch("greedy-capture", "auto Lambda = [=](int32 X) { return X; };", "[=] with params")
expect_catch("greedy-capture", "auto Lambda = [&] { DoThing(); };", "[&] no-arg lambda")
expect_catch("greedy-capture", "auto Lambda = [=] { DoThing(); };", "[=] no-arg lambda")

expect_allow("greedy-capture", "auto Lambda = [this, &Name](int32 X) { return X; };", "explicit captures")
expect_allow("greedy-capture", "auto Lambda = [Self = this]() { Self->Do(); };", "init capture")
expect_allow("greedy-capture", "TArray<int32> Arr = {1, 2, 3};", "braced init (not a lambda)")
expect_allow("greedy-capture", "// [&] is bad", "comment")

# ─── Rule 3: Raw new ────────────────────────────────────────────────────────

print("Rule 3: Raw new")

expect_catch("raw-new", "FMyClass* Obj = new FMyClass();", "raw new FMyClass")
expect_catch("raw-new", "return new FWidget(Args);", "raw new in return")
expect_catch("raw-new", "    auto* Thing = new FBigThing;", "raw new without parens")

expect_allow("raw-new", "UMyObject* Obj = NewObject<UMyObject>(this);", "NewObject")
expect_allow("raw-new", "auto Ptr = MakeShared<FThing>();", "MakeShared")
expect_allow("raw-new", "auto Ptr = MakeUnique<FThing>();", "MakeUnique")
expect_allow("raw-new", "auto* Sub = CreateDefaultSubobject<UComp>(TEXT(\"Comp\"));", "CreateDefaultSubobject")
expect_allow("raw-new", "int32 NewCount = OldCount + 1;", "variable named New-something")
expect_allow("raw-new", "// new FThing is wrong", "comment")
expect_allow("raw-new", "void OnNewMember();", "function with New in name")
expect_allow("raw-new", 'checkf(Ptr, TEXT("Received nullptr for new BuildableSaveData"));', "new inside TEXT macro")
expect_allow("raw-new", 'UE_LOG(LogResort, Error, TEXT("Failed to create new Instance"));', "new inside UE_LOG string")

# ─── Rule 4: Multiple declarations ──────────────────────────────────────────

print("Rule 4: Multiple declarations")

expect_catch("multi-decl", "int32 X, Y;", "two ints on one line")
expect_catch("multi-decl", "float A, B = 0.f;", "two floats, one initialised")

expect_allow("multi-decl", "int32 X;", "single declaration")
expect_allow("multi-decl", "void Foo(int32 X, int32 Y);", "function parameters")
expect_allow("multi-decl", "for (int32 I = 0, N = Arr.Num(); I < N; ++I)", "for-loop init")
expect_allow("multi-decl", "TMap<FString, int32> Map;", "template with comma")
expect_allow("multi-decl", "template<typename T, typename = std::enable_if_t<std::is_base_of_v<USceneComponent, T>>>", "template parameter list")

# ─── False positive regression: block comment continuation lines ─────────────

print("Regression: Block comments")

expect_allow("east-const", "* PreProcessors run exclusively when a new Buildable is created.", "block comment continuation")
expect_allow("raw-new", "* and choose to start a new Framework or return to their current one.", "block comment with 'new' in prose")

# ─── Rule 5: Uninitialised TSharedRef ───────────────────────────────────────

print("Rule 5: Uninitialised TSharedRef")

expect_catch("tsharedref", "TSharedRef<FMyThing> Thing;", "uninitialised TSharedRef field")
expect_catch("tsharedref", "    TSharedRef<SWidget> Widget;", "indented uninitialised TSharedRef")

expect_allow("tsharedref", "TSharedRef<FMyThing> Thing = MakeShared<FMyThing>();", "initialised with MakeShared")
expect_allow("tsharedref", "TSharedRef<FMyThing> Thing{MakeShared<FMyThing>()};", "brace-initialised")
expect_allow("tsharedref", "TSharedPtr<FMyThing> Thing;", "TSharedPtr is fine uninitialised")
expect_allow("tsharedref", "// TSharedRef<FMyThing> Thing;", "comment")
expect_allow("tsharedref", "void Foo(TSharedRef<FMyThing> Thing);", "function parameter (has parens)")

# ─── Rule 6: IILE ───────────────────────────────────────────────────────────

print("Rule 6: IILE")

expect_catch("iile", "auto X = [this]() -> int32 { return 42; }();", "IILE with return type")
expect_catch("iile", "auto X = []() { return 42; }();", "IILE minimal")

expect_allow("iile", "auto Lambda = [this]() { return 42; };", "stored lambda (not invoked)")
expect_allow("iile", "Callback();", "regular function call")

# ─── Summary ────────────────────────────────────────────────────────────────

print()
print(f"Results: {PASS} passed, {FAIL} failed out of {PASS + FAIL} cases")
if FAIL:
    sys.exit(1)
else:
    print("All cases passed.")
