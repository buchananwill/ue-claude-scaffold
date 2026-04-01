#!/usr/bin/env python
"""
Agent Compiler — resolves dynamic agent definitions into standalone agent files.

A dynamic agent is a markdown file with YAML frontmatter that includes a `skills`
list. The compiler reads each referenced skill, splices its content into the agent's
system prompt body, and writes a standard Claude Code agent file (no `skills` field)
to the output directory.

Usage:
    python scripts/compile-agent.py dynamic-agents/container-orchestrator.md
    python scripts/compile-agent.py dynamic-agents/container-orchestrator.md --recursive
    python scripts/compile-agent.py dynamic-agents/container-implementer.md -o /tmp/agents
    python scripts/compile-agent.py --all
    python scripts/compile-agent.py --all -o .compiled-agents
    python scripts/compile-agent.py --clean          # remove output dir

With --recursive, the compiler scans the lead agent's compiled skill content for
references to other dynamic agents and compiles those too (one level only).
Sub-agents that reference further agents trigger a warning, not recursion.

The compiled output is ephemeral — not committed, consumed by containers or
local sessions, then discarded.
"""

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SKILLS_DIR = REPO_ROOT / "skills"
DEFAULT_DYNAMIC_DIR = REPO_ROOT / "dynamic-agents"
DEFAULT_OUTPUT_DIR = REPO_ROOT / ".compiled-agents"

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?\n)---\s*\n", re.DOTALL)
ACCESS_SCOPE_RE = re.compile(r"^\*{3}ACCESS SCOPE:\s*(.+?)\*{3}\s*$", re.MULTILINE)

# Privilege ordering for access scopes.  When multiple skills declare scopes,
# the highest rank wins.  Unknown scopes default to rank 1 (write-access).
SCOPE_RANK: dict[str, int] = {
    "read-only": 0,
    "write-access": 1,
    "ubt-build-hook-interceptor": 2,
}


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split a markdown file into frontmatter dict and body.

    Uses simple line-based parsing to avoid a PyYAML dependency.
    Handles scalar values, single-line lists (JSON-style), and multi-line lists.
    """
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text

    raw = m.group(1)
    body = text[m.end():]
    meta = {}
    current_key = None

    for line in raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or stripped == "":
            continue

        # Continuation of a multi-line list
        if line.startswith("  - ") and current_key is not None:
            val = line.strip().lstrip("- ").strip()
            if isinstance(meta[current_key], list):
                meta[current_key].append(val)
            continue

        if ":" not in line:
            continue

        key, val = line.split(":", 1)
        key = key.strip()
        val = val.strip()
        current_key = key

        # Inline list: [a, b, c] or ["a", "b", "c"]
        if val.startswith("[") and val.endswith("]"):
            items = val[1:-1].split(",")
            meta[key] = [i.strip().strip('"').strip("'") for i in items if i.strip()]
        # Quoted string
        elif (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            meta[key] = val[1:-1]
        # Empty value — start of a multi-line list
        elif val == "":
            meta[key] = []
        else:
            meta[key] = val

    return meta, body


def serialize_frontmatter(meta: dict) -> str:
    """Serialize a metadata dict back to YAML frontmatter."""
    lines = ["---"]
    for key, val in meta.items():
        if isinstance(val, list):
            # Inline list format for compactness
            quoted = ", ".join(val)
            lines.append(f"{key}: [{quoted}]")
        elif isinstance(val, str) and ("\n" in val or ":" in val or '"' in val):
            lines.append(f'{key}: "{val}"')
        else:
            lines.append(f"{key}: {val}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def resolve_skill(name: str, skills_dir: Path) -> tuple[str, str | None]:
    """Load a skill's content (body only, no frontmatter) by name.

    Returns (body, access_scope) where access_scope is the value from an
    ``***ACCESS SCOPE: {value}***`` marker line, or None if absent.
    The marker line is stripped from the returned body.
    """
    skill_path = skills_dir / name / "SKILL.md"
    if not skill_path.exists():
        print(f"ERROR: Skill '{name}' not found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    text = skill_path.read_text(encoding="utf-8")
    _, body = parse_frontmatter(text)

    scope: str | None = None
    m = ACCESS_SCOPE_RE.search(body)
    if m:
        scope = m.group(1).strip()
        body = body[: m.start()] + body[m.end() :]

    return body.strip(), scope


def compile_agent(
    source: Path,
    output_dir: Path,
    skills_dir: Path,
) -> tuple[Path, str]:
    """Compile a dynamic agent definition into a standalone agent file.

    Returns (output_path, compiled_body) — the body is needed for recursive
    sub-agent scanning.
    """
    text = source.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(text)

    skills = meta.pop("skills", [])
    if not skills:
        print(f"WARNING: {source.name} has no skills listed — copying as-is", file=sys.stderr)

    # Build the compiled body: original "why" paragraph + injected skills
    sections = [body.strip()]

    highest_scope = "read-only"
    for skill_name in skills:
        skill_content, scope = resolve_skill(skill_name, skills_dir)
        if scope is not None:
            if SCOPE_RANK.get(scope, 1) > SCOPE_RANK.get(highest_scope, 0):
                highest_scope = scope
        sections.append(skill_content)

    compiled_body = "\n\n".join(sections).rstrip() + "\n"
    compiled_frontmatter = serialize_frontmatter(meta)

    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / source.name
    out_path.write_text(compiled_frontmatter + "\n" + compiled_body, encoding="utf-8")

    # Write sidecar metadata (consumed by container entrypoint, not by Claude Code)
    meta_path = output_dir / (source.stem + ".meta.json")
    meta_path.write_text(
        json.dumps({"access-scope": highest_scope}, indent=2) + "\n",
        encoding="utf-8",
    )

    return out_path, compiled_body


def find_sub_agents(compiled_body: str, dynamic_dir: Path, exclude: set[str]) -> list[Path]:
    """Scan compiled body for references to other dynamic agents.

    Matches any occurrence of a dynamic agent name (filename sans .md extension)
    in the compiled text. Returns paths to matched dynamic agent source files,
    excluding any names in the exclude set (already compiled).
    """
    candidates = {}
    for f in dynamic_dir.glob("*.md"):
        name = f.stem  # e.g. "container-implementer"
        candidates[name] = f

    matched = []
    for name, path in sorted(candidates.items()):
        if name in exclude:
            continue
        # Match the agent name as a whole word (not a substring of something else)
        if re.search(r'\b' + re.escape(name) + r'\b', compiled_body):
            matched.append(path)

    return matched


def main():
    parser = argparse.ArgumentParser(
        description="Compile dynamic agent definitions by injecting skill content."
    )
    parser.add_argument(
        "source",
        nargs="?",
        help="Path to a dynamic agent .md file",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help=f"Compile all dynamic agents in {DEFAULT_DYNAMIC_DIR.relative_to(REPO_ROOT)}",
    )
    parser.add_argument(
        "-o", "--output",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Output directory (default: {DEFAULT_OUTPUT_DIR.relative_to(REPO_ROOT)})",
    )
    parser.add_argument(
        "--skills-dir",
        type=Path,
        default=DEFAULT_SKILLS_DIR,
        help=f"Skills directory (default: {DEFAULT_SKILLS_DIR.relative_to(REPO_ROOT)})",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Scan compiled lead agent for sub-agent references and compile those too (one level)",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove the output directory and exit",
    )

    args = parser.parse_args()

    if args.clean:
        if args.output.exists():
            shutil.rmtree(args.output)
            print(f"Removed {args.output}")
        else:
            print(f"Nothing to clean — {args.output} does not exist")
        return

    if args.all:
        sources = sorted(DEFAULT_DYNAMIC_DIR.glob("*.md"))
        if not sources:
            print(f"No dynamic agents found in {DEFAULT_DYNAMIC_DIR}", file=sys.stderr)
            sys.exit(1)
    elif args.source:
        sources = [Path(args.source)]
    else:
        parser.print_help()
        sys.exit(1)

    compiled_names = set()
    sub_agent_paths = []

    # Phase 1: compile requested agents
    for src in sources:
        out, body = compile_agent(src, args.output, args.skills_dir)
        compiled_names.add(src.stem)
        print(f"  {src.name} -> {out}")

        if args.recursive:
            subs = find_sub_agents(body, DEFAULT_DYNAMIC_DIR, compiled_names)
            sub_agent_paths.extend(subs)
            compiled_names.update(s.stem for s in subs)

    # Phase 2: compile discovered sub-agents (one level, no further recursion)
    if sub_agent_paths:
        print(f"\n  Sub-agents referenced in skills:")
        for sub_src in sub_agent_paths:
            out, sub_body = compile_agent(sub_src, args.output, args.skills_dir)
            print(f"    {sub_src.name} -> {out}")

            # Warn if sub-agent's skills reference further agents (config bug)
            further = find_sub_agents(sub_body, DEFAULT_DYNAMIC_DIR, compiled_names)
            for f in further:
                print(
                    f"  WARNING: sub-agent {sub_src.stem} references {f.stem} "
                    f"— sub-agents cannot launch sub-agents. Skipping.",
                    file=sys.stderr,
                )

    total = len(sources) + len(sub_agent_paths)
    print(f"\nCompiled {total} agent(s) to {args.output}")


if __name__ == "__main__":
    main()
