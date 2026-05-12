#!/bin/bash
# container/lib/stage-plugins.sh — Stage allowlisted Claude Code plugins.
# Sourced by entrypoint.sh; do not execute directly.
#
# The host's full plugins directory is read-only-mounted at /host-plugins by
# docker-compose. This module reads the CLAUDE_PLUGINS_ALLOW comma-separated
# allowlist and copies just those plugin subdirectories into the container's
# Claude Code plugin path at /home/claude/.claude/plugins, so the FSM role
# session's Skill / Agent tool listings broaden to include those plugins'
# offerings (skills, sub-agents, MCP servers). Anything outside the allowlist
# stays invisible to the agent.
#
# An empty CLAUDE_PLUGINS_ALLOW is the no-op default — the container runs with
# a bare Claude Code install, same as before this module existed.

_PLUGINS_HOST_DIR="/host-plugins"
_PLUGINS_TARGET_DIR="/home/claude/.claude/plugins"

# Whole-word allowlist for plugin directory names. Matches the same regex used
# for agent names elsewhere in the container — alphanumeric plus underscore,
# hyphen, dot, and forward slash so plugin subgroups like "vercel/nextjs" can
# also be staged when the host stores them that way.
_PLUGIN_NAME_RE='^[a-zA-Z0-9._/-]{1,64}$'

_stage_claude_plugins() {
    if [ -z "${CLAUDE_PLUGINS_ALLOW:-}" ]; then
        echo "── Plugin staging: CLAUDE_PLUGINS_ALLOW is empty; no plugins staged. ──"
        return 0
    fi

    if [ ! -d "$_PLUGINS_HOST_DIR" ]; then
        echo "── Plugin staging: /host-plugins not mounted; skipping. ──" >&2
        return 0
    fi

    mkdir -p "$_PLUGINS_TARGET_DIR"

    local IFS=','
    local staged_count=0
    local missing_count=0
    local rejected_count=0
    local name
    for name in $CLAUDE_PLUGINS_ALLOW; do
        # Strip surrounding whitespace (operators often write `a, b, c`).
        name="${name#"${name%%[![:space:]]*}"}"
        name="${name%"${name##*[![:space:]]}"}"
        [ -z "$name" ] && continue

        if ! [[ "$name" =~ $_PLUGIN_NAME_RE ]]; then
            echo "  rejected: '${name}' (does not match ${_PLUGIN_NAME_RE})" >&2
            rejected_count=$((rejected_count + 1))
            continue
        fi

        local src="${_PLUGINS_HOST_DIR}/${name}"
        local dst="${_PLUGINS_TARGET_DIR}/${name}"

        if [ ! -d "$src" ]; then
            echo "  missing: '${name}' (no directory at ${src})" >&2
            missing_count=$((missing_count + 1))
            continue
        fi

        # Idempotent: skip if already staged (re-launching the same container).
        if [ -d "$dst" ]; then
            echo "  cached:  ${name}"
            staged_count=$((staged_count + 1))
            continue
        fi

        # Recursive copy. dst's parent is /home/claude/.claude/plugins, which
        # mkdir -p above created; nested plugin names (e.g. vercel/nextjs)
        # need their containing directories created up-front.
        mkdir -p "$(dirname "$dst")"
        if cp -R "$src" "$dst" 2>/dev/null; then
            echo "  staged:  ${name}"
            staged_count=$((staged_count + 1))
        else
            echo "  ERROR:   failed to copy ${src} → ${dst}" >&2
        fi
    done

    echo "── Plugin staging: ${staged_count} staged, ${missing_count} missing, ${rejected_count} rejected. ──"
}
