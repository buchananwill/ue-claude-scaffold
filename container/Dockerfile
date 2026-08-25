# ── clang-format builder ──────────────────────────────────────────────────
# Pinned to the host toolchain's version (LLVM 19.1.7) so the container and the
# host produce the same formatting. Staged separately because the only way to
# get a pinned build is the PyPI wheel, and python3-pip costs ~110MB that the
# runtime image does not need — copying just the 3.9MB binary out keeps the
# final image ~5MB larger instead.
FROM node:22-slim AS cfbuild
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip \
    && pip install --break-system-packages --target /cf clang-format==19.1.7

FROM node:22-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    git-lfs \
    curl \
    jq \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Git LFS, installed *in order to not download*. Target repos route large
# binary assets through LFS (PistePerfect: Content/**/*.uasset and *.umap,
# 6+ GB of objects). LFS bytes only move at checkout time via the smudge
# filter, or on an explicit `git lfs fetch`/`pull` -- a clone or fetch
# transfers the 131-byte pointer blobs and nothing more. `--skip-smudge`
# therefore leaves the pointer in the working tree and keeps /workspace at
# source-code size.
#
# The binary is required even though the container never wants the bytes:
# with `filter=lfs` declared in .gitattributes and no git-lfs on PATH, git's
# checkout fails outright rather than quietly writing pointers. --skip-smudge
# also leaves the *clean* filter live, so a pointer file round-trips to a
# byte-identical pointer -- `git status` stays clean, and lib/finalize.sh's
# `git add -A` cannot commit a mangled asset.
#
# Host-side staging worktrees are the ones that need real asset bytes (they
# run UBT and the editor); they smudge normally and are unaffected by this.
RUN git lfs install --system --skip-smudge
ENV GIT_LFS_SKIP_SMUDGE=1

# clang-format, for projects whose style gate shells out to it (e.g.
# PistePerfect's Scripts/format.py, which invokes a bare `clang-format`).
COPY --from=cfbuild /cf/clang_format/data/bin/clang-format /usr/local/bin/clang-format

# ── Project-specific dependencies ─────────────────────────────────────────
# Extend the image with packages your build scripts need.
# Example:
#
# RUN apt-get update && apt-get install -y --no-install-recommends \
#     build-essential \
#     && rm -rf /var/lib/apt/lists/*

# pnpm, for workspace projects whose build/test scripts are pnpm-driven (e.g.
# procedural-geometry-ideas, a pnpm-workspaces monorepo). Pinned to the version
# the host uses so the committed pnpm-lock.yaml (lockfileVersion 9.0) resolves
# identically in the container.
#
# Deliberately NOT `corepack enable` + `corepack prepare`: corepack installs a
# shim that re-resolves the version at run time, per-user. Because the runtime
# user (`claude`) has its own COREPACK cache and the target repo pins no
# `packageManager` field, that shim silently fetched pnpm 11 and changed
# behaviour — notably making ERR_PNPM_IGNORED_BUILDS fatal. A plain global
# install gives one fixed binary for every user.
RUN npm install -g pnpm@10.14.0

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user (Claude Code refuses root + --dangerously-skip-permissions)
RUN useradd -m -s /bin/bash claude

# Copy hook scripts and container settings
COPY hooks/ /claude-hooks/
COPY container-settings.json /container-settings.json
RUN chmod +x /claude-hooks/*.sh

# Copy and install chat channel MCP server
COPY mcp-servers/ /mcp-servers/
RUN npm install --omit=dev --prefix /mcp-servers

# Copy entrypoint and library helpers
COPY entrypoint.sh /scaffold/entrypoint.sh
COPY lib /scaffold/lib
RUN chmod +x /scaffold/entrypoint.sh

# Smoke-test: verify runtime dependencies
RUN node --version && npm --version && \
    git lfs version && \
    pnpm --version && \
    python3 --version && \
    clang-format --version && \
    node --check /claude-hooks/lint-cpp-diff.mjs

# Create directories owned by claude user
RUN mkdir -p /workspace /task /home/claude/.claude \
    && chown claude:claude /workspace /task /home/claude/.claude

USER claude
WORKDIR /workspace

ENTRYPOINT ["/scaffold/entrypoint.sh"]
