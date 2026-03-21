#!/usr/bin/env python3
"""
PostToolUse lint hook for Edit/Write on C++ files.

Checks the new content (from Edit's new_string or Write's content) against
mechanical rules that are always wrong in Unreal Engine C++. Returns feedback
lines that the agent sees immediately.

Input: JSON on stdin with tool_input containing either:
  - new_string (Edit tool)
  - content (Write tool)
  - file_path

Exit 0: no issues (tool proceeds)
Exit 0 with stdout: issues found (tool proceeds, agent sees feedback)
We never block the write — just surface the problems immediately.
"""

import json
import re
import sys


def check_lines(lines: list[str], file_path: str) -> list[str]:
    issues: list[str] = []

    # Track multiline state for IILE detection
    full_text = "\n".join(lines)

    for i, line in enumerate(lines, start=1):
        stripped = line.strip()

        # Skip comments and preprocessor
        if stripped.startswith("//") or stripped.startswith("#") or stripped.startswith("/*") or stripped.startswith("*"):
            continue

        # Rule 1: East-const violation
        # Match "const Type&" or "const Type*" but not "const_cast" or "constexpr"
        if re.search(r"\bconst\s+(?!cast|expr|eval)\w+[\s*&]", line):
            # Exclude "const char*" in string literal contexts and return type positions
            # that are const-pointer-to-const (e.g. "FSlateBrush const* const")
            match = re.search(r"\bconst\s+(\w+)\s*[&*]", line)
            if match:
                typename = match.group(1)
                # Skip if it's a const pointer itself (const int* const)
                if typename not in ("cast", "expr", "eval", "override", "noexcept"):
                    issues.append(
                        f"  LINT [{file_path}:{i}] East-const: "
                        f"'const {typename}' should be '{typename} const'. "
                        f"Line: {stripped[:80]}"
                    )

        # Rule 2: Greedy lambda captures [&] or [=]
        if re.search(r"\[&\]\s*\(", line) or re.search(r"\[=\]\s*\(", line):
            issues.append(
                f"  LINT [{file_path}:{i}] Greedy capture: "
                f"use explicit captures instead of [&] or [=]. "
                f"Line: {stripped[:80]}"
            )
        # Also catch [&] and [=] without parens (no-arg lambdas)
        elif re.search(r"\[&\]\s*\{", line) or re.search(r"\[=\]\s*\{", line):
            issues.append(
                f"  LINT [{file_path}:{i}] Greedy capture: "
                f"use explicit captures instead of [&] or [=]. "
                f"Line: {stripped[:80]}"
            )

        # Rule 3: Raw new (outside blessed functions)
        # Match "new TypeName" but exclude NewObject, MakeShared, MakeUnique,
        # CreateDefaultSubobject, placement new, and operator new
        # Strip string literals before checking for raw new
        line_no_strings = re.sub(r'TEXT\s*\([^)]*\)', '', re.sub(r'"[^"]*"', '', line))
        new_match = re.search(r"\bnew\s+([A-Z]\w+)", line_no_strings)
        if new_match:
            # Check the broader context — is this inside a blessed call?
            blessed = ("NewObject", "MakeShared", "MakeUnique", "MakeShareable",
                       "CreateDefaultSubobject", "placement", "operator")
            if not any(b in line_no_strings for b in blessed):
                issues.append(
                    f"  LINT [{file_path}:{i}] Raw new: "
                    f"use NewObject<T>, MakeShared<T>, or MakeUnique<T> instead. "
                    f"Line: {stripped[:80]}"
                )

        # Rule 4: Multiple declarations on one line
        # Detect "Type Name1, Name2;" pattern (simplified)
        if re.search(r"^\s*\w[\w:<>*&\s]+\s+\w+\s*,\s*\w+\s*[;=]", line):
            # Exclude function parameter lists, for-loop inits, and template parameter lists
            if ("(" not in line.split(",")[0]
                    and not stripped.startswith("for")
                    and not stripped.startswith("template")):
                issues.append(
                    f"  LINT [{file_path}:{i}] Multiple declarations: "
                    f"declare one symbol per line. "
                    f"Line: {stripped[:80]}"
                )

        # Rule 5: Uninitialised TSharedRef member field
        # TSharedRef<SomeType> FieldName; (no = or { initialiser)
        if re.search(r"\bTSharedRef\s*<[^>]+>\s+\w+\s*;", line):
            if "=" not in line and "{" not in line:
                issues.append(
                    f"  LINT [{file_path}:{i}] Uninitialised TSharedRef: "
                    f"TSharedRef has no null state — initialise with MakeShared<T>() "
                    f"or use TSharedPtr if initialisation is deferred. "
                    f"Line: {stripped[:80]}"
                )

    # Rule 6: IILE detection (multiline — scan full text)
    # Pattern: ](optional-params) -> optional-return { ... }()
    iile_pattern = re.compile(
        r"\]\s*\([^)]*\)\s*(?:->[^{]+)?\s*\{[^}]*\}\s*\(\)",
        re.DOTALL
    )
    for match in iile_pattern.finditer(full_text):
        # Find the line number
        line_num = full_text[:match.start()].count("\n") + 1
        context = full_text[match.start():match.end()].split("\n")[0].strip()[:80]
        issues.append(
            f"  LINT [{file_path}:{line_num}] IILE: "
            f"immediately invoked lambda — extract to a named variable or function. "
            f"Line: {context}"
        )

    return issues


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        sys.exit(0)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_input = data.get("tool_input", {})
    file_path = tool_input.get("file_path", "")

    # Only lint C++ files
    if not file_path.endswith((".h", ".cpp", ".inl")):
        sys.exit(0)

    # Get the content being written
    content = tool_input.get("new_string") or tool_input.get("content") or ""
    if not content:
        sys.exit(0)

    lines = content.split("\n")
    issues = check_lines(lines, file_path)

    if issues:
        print(f"C++ lint ({len(issues)} issue{'s' if len(issues) != 1 else ''}):")
        for issue in issues:
            print(issue)
        print()
        print("Fix these before proceeding. These patterns are always wrong in this codebase.")

    sys.exit(0)


if __name__ == "__main__":
    main()
