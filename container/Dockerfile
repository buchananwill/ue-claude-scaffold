FROM node:22-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user (Claude Code refuses root + --dangerously-skip-permissions)
RUN useradd -m -s /bin/bash claude

# Copy hook scripts and container settings
COPY hooks/ /claude-hooks/
COPY container-settings.json /container-settings.json
RUN chmod +x /claude-hooks/*.sh

# Copy workspace setup scripts
COPY patch_workspace.py /patch_workspace.py
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create directories owned by claude user
RUN mkdir -p /workspace /task && chown claude:claude /workspace
RUN mkdir -p /home/claude/.claude && chown claude:claude /home/claude/.claude

USER claude
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
