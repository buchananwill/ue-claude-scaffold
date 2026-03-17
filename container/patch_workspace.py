#!/usr/bin/env python3
"""
Patches CLAUDE.md and workspace configuration for the container environment.

Reads remapping rules from environment variables or a config file.
Handles:
  - Path remapping (Windows host paths → container mount points)
  - Agent substitutions (host-only agents → container-compatible alternatives)
  - Plugin symlinking from read-only mounts
"""

import json
import os
import re
from pathlib import Path

WORKSPACE = Path("/workspace")
CLAUDE_MD = WORKSPACE / "CLAUDE.md"
WORKTREE_CLAUDE_MD = WORKSPACE / ".claude" / "CLAUDE.md"


def load_config() -> dict:
    """Load scaffold config from mounted config file or env vars."""
    config_path = Path("/config/scaffold.config.json")
    if config_path.is_file():
        return json.loads(config_path.read_text(encoding="utf-8"))

    # Fall back to env-var based config
    return {
        "claudeMdPatches": {
            "pathRemaps": json.loads(os.environ.get("CLAUDE_MD_PATH_REMAPS", "{}")),
            "agentSubstitutions": json.loads(
                os.environ.get("CLAUDE_MD_AGENT_SUBS", "{}")
            ),
        }
    }


def patch_claude_md(config: dict):
    """Apply path remaps and agent substitutions to CLAUDE.md."""
    if not CLAUDE_MD.exists():
        return

    text = CLAUDE_MD.read_text(encoding="utf-8")
    patches = config.get("claudeMdPatches", {})

    # Apply path remaps
    for host_path, container_path in patches.get("pathRemaps", {}).items():
        # Handle both single-backslash and double-backslash escapes
        text = text.replace(host_path, container_path)
        escaped = host_path.replace("\\", "\\\\")
        if escaped != host_path:
            text = text.replace(escaped, container_path)

    # Apply agent substitutions
    # Each substitution maps an agent name to a replacement block
    for agent_name, replacement in patches.get("agentSubstitutions", {}).items():
        # Replace bullet-point references in "Agents and Skills" sections
        pattern = rf"- \*\*`{re.escape(agent_name)}` agent\*\*.*?(?=\n- \*\*|\n###|\n##)"
        text = re.sub(pattern, replacement + "\n\n", text, flags=re.DOTALL)

        # Replace references in orchestrator role mapping tables
        text = text.replace(
            f"Must use `{agent_name}`",
            replacement.split("—")[0].strip() if "—" in replacement else replacement,
        )

    CLAUDE_MD.write_text(text, encoding="utf-8")
    print("Patched CLAUDE.md")


def patch_worktree_claude_md(config: dict):
    """Patch the worktree-specific CLAUDE.md with path remaps."""
    if not WORKTREE_CLAUDE_MD.exists():
        return

    text = WORKTREE_CLAUDE_MD.read_text(encoding="utf-8")
    patches = config.get("claudeMdPatches", {})

    for host_path, container_path in patches.get("pathRemaps", {}).items():
        text = text.replace(host_path, container_path)

    WORKTREE_CLAUDE_MD.write_text(text, encoding="utf-8")
    print("Patched .claude/CLAUDE.md")


def symlink_plugins():
    """Symlink read-only plugin mounts into the workspace Plugins/ directory."""
    plugins_ro = Path("/plugins-ro")
    plugins_dir = WORKSPACE / "Plugins"
    plugins_dir.mkdir(parents=True, exist_ok=True)

    if not plugins_ro.exists():
        print("No /plugins-ro mount found, skipping plugin symlinks")
        return

    for plugin_dir in plugins_ro.iterdir():
        if plugin_dir.is_dir():
            link = plugins_dir / plugin_dir.name
            if not link.exists():
                link.symlink_to(plugin_dir)
                print(f"Symlinked {plugin_dir} -> {link}")


if __name__ == "__main__":
    cfg = load_config()
    patch_claude_md(cfg)
    patch_worktree_claude_md(cfg)
    symlink_plugins()
