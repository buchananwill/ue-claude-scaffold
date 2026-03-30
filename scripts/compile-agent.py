#!/usr/bin/env python
"""
Agent Compiler — resolves dynamic agent definitions into standalone agent files.

A dynamic agent is a markdown file with YAML frontmatter that includes a `skills`
list. The compiler reads each referenced skill, splices its content into the agent's
system prompt body, and writes a standard Claude Code agent file (no `skills` field)
to the output directory.

Usage:
    python scripts/compile-agent.py dynamic-agents/container-implementer.md
    python scripts/compile-agent.py dynamic-agents/container-implementer.md -o /tmp/agents
    python scripts/compile-agent.py --all
    python scripts/compile-agent.py --all -o .compiled-agents
    python scripts/compile-agent.py --clean          # remove output dir

The compiled output is ephemeral — not committed, consumed by containers or
local sessions, then discarded.
"""

import argparse
import re
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SKILLS_DIR = REPO_ROOT / "skills"
DEFAULT_DYNAMIC_DIR = REPO_ROOT / "dynamic-agents"
DEFAULT_OUTPUT_DIR = REPO_ROOT / ".compiled-agents"

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?\n)---\s*\n", re.DOTALL)


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


def resolve_skill(name: str, skills_dir: Path) -> str:
    """Load a skill's content (body only, no frontmatter) by name."""
    skill_path = skills_dir / name / "SKILL.md"
    if not skill_path.exists():
        print(f"ERROR: Skill '{name}' not found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    text = skill_path.read_text(encoding="utf-8")
    _, body = parse_frontmatter(text)
    return body.strip()


def compile_agent(
    source: Path,
    output_dir: Path,
    skills_dir: Path,
) -> Path:
    """Compile a dynamic agent definition into a standalone agent file."""
    text = source.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(text)

    skills = meta.pop("skills", [])
    if not skills:
        print(f"WARNING: {source.name} has no skills listed — copying as-is", file=sys.stderr)

    # Build the compiled body: original "why" paragraph + injected skills
    sections = [body.strip()]

    if skills:
        sections.append("\n---\n")
        sections.append("<!-- Injected skills (compiled from dynamic-agents) -->\n")

    for skill_name in skills:
        skill_content = resolve_skill(skill_name, skills_dir)
        sections.append(skill_content)
        sections.append("")  # blank line between skills

    compiled_body = "\n\n".join(sections).rstrip() + "\n"
    compiled_frontmatter = serialize_frontmatter(meta)

    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / source.name
    out_path.write_text(compiled_frontmatter + "\n" + compiled_body, encoding="utf-8")
    return out_path


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

    for src in sources:
        out = compile_agent(src, args.output, args.skills_dir)
        print(f"  {src.name} -> {out}")

    print(f"\nCompiled {len(sources)} agent(s) to {args.output}")


if __name__ == "__main__":
    main()
