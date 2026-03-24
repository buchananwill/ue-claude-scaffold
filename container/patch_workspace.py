#!/usr/bin/env python3
"""
Sets up read-only plugin symlinks in the container workspace.

Read-only plugin mounts at /plugins-ro/<PluginName> are symlinked into the
workspace's Plugins/ directory so UBT can discover them during builds.
"""

from pathlib import Path

WORKSPACE = Path("/workspace")


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
    symlink_plugins()
