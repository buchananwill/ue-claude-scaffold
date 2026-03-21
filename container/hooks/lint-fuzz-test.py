#!/usr/bin/env python3
"""
Fuzz test: run the linter against real codebase files to detect false positives.
Any issues found here are potential false positives that need investigation —
the existing codebase is the baseline of "known acceptable code".
"""

import sys
import os
import glob
import random

sys.path.insert(0, os.path.dirname(__file__))
import importlib.util
spec = importlib.util.spec_from_file_location("lint", os.path.join(os.path.dirname(__file__), "lint-cpp-diff.py"))
lint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lint)

check_lines = lint.check_lines


def main():
    codebase = sys.argv[1] if len(sys.argv) > 1 else "D:/coding/resort_game/PistePerfect_5_7/Source"

    # Gather all C++ files
    patterns = [
        os.path.join(codebase, "**", "*.h"),
        os.path.join(codebase, "**", "*.cpp"),
    ]
    all_files = []
    for p in patterns:
        all_files.extend(glob.glob(p, recursive=True))

    if not all_files:
        print(f"No C++ files found in {codebase}")
        sys.exit(1)

    # Sample — use all files for thorough check, or pass --sample N
    sample_size = len(all_files)
    for i, arg in enumerate(sys.argv):
        if arg == "--sample" and i + 1 < len(sys.argv):
            sample_size = int(sys.argv[i + 1])

    if sample_size < len(all_files):
        files = random.sample(all_files, sample_size)
    else:
        files = all_files

    total_issues = 0
    files_with_issues = 0
    issues_by_rule = {}

    for file_path in files:
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.read().split("\n")
        except Exception:
            continue

        issues = check_lines(lines, file_path)
        if issues:
            files_with_issues += 1
            total_issues += len(issues)
            for issue in issues:
                # Extract rule name from the LINT message
                if "East-const" in issue:
                    rule = "east-const"
                elif "Greedy capture" in issue:
                    rule = "greedy-capture"
                elif "Raw new" in issue:
                    rule = "raw-new"
                elif "Multiple declarations" in issue:
                    rule = "multi-decl"
                elif "TSharedRef" in issue:
                    rule = "tsharedref"
                elif "IILE" in issue:
                    rule = "iile"
                else:
                    rule = "unknown"
                issues_by_rule.setdefault(rule, []).append(issue)

    print(f"Scanned {len(files)} files ({len(all_files)} total in codebase)")
    print(f"Files with issues: {files_with_issues}")
    print(f"Total issues: {total_issues}")
    print()

    for rule, rule_issues in sorted(issues_by_rule.items()):
        print(f"  {rule}: {len(rule_issues)} hits")
        # Show first 3 examples
        for example in rule_issues[:3]:
            print(f"    {example.strip()}")
        if len(rule_issues) > 3:
            print(f"    ... and {len(rule_issues) - 3} more")
        print()

    if total_issues > 0:
        print("INVESTIGATE: These may be false positives (existing code is the baseline)")
        print("or they may be genuine pre-existing violations.")
    else:
        print("CLEAN: No issues found in sampled files.")


if __name__ == "__main__":
    main()
