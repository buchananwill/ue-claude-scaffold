FROM node:22-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
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
RUN cd /mcp-servers && npm install --omit=dev

# Copy workspace setup scripts
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Smoke-test: verify runtime dependencies and absence of Python
RUN node --version && npm --version && ! which python3

# Create directories owned by claude user
RUN mkdir -p /workspace /task && chown claude:claude /workspace
RUN mkdir -p /home/claude/.claude && chown claude:claude /home/claude/.claude

USER claude
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
