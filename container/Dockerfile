FROM node:22-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# ── Project-specific dependencies ─────────────────────────────────────────
# Extend the image with packages your build scripts need.
# Example:
#
# RUN apt-get update && apt-get install -y --no-install-recommends \
#     build-essential \
#     && rm -rf /var/lib/apt/lists/*

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
    python3 --version && \
    node --check /claude-hooks/lint-cpp-diff.mjs

# Create directories owned by claude user
RUN mkdir -p /workspace /task /home/claude/.claude \
    && chown claude:claude /workspace /task /home/claude/.claude

USER claude
WORKDIR /workspace

ENTRYPOINT ["/scaffold/entrypoint.sh"]
