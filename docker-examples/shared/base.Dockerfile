# Base image for mclaude orchestration workers
# Includes: Node.js, cc-mirror (mclaude), GitHub CLI, Git with SSH support

FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    curl \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install cc-mirror globally (this provides the 'mc' command)
RUN npm install -g cc-mirror

# Create working directories
RUN mkdir -p /app /workspace /root/.ssh /root/.cc-mirror

# Configure SSH for git operations (disable strict host checking for automation)
RUN echo "Host *\n\tStrictHostKeyChecking no\n\tUserKnownHostsFile=/dev/null" > /root/.ssh/config \
    && chmod 600 /root/.ssh/config

# Pre-create mclaude variant configuration directory
ENV MCLAUDE_CONFIG_DIR=/root/.cc-mirror/mc
ENV MCLAUDE_VARIANT=mc

# Create mclaude config directory structure
RUN mkdir -p ${MCLAUDE_CONFIG_DIR}/config/skills ${MCLAUDE_CONFIG_DIR}/config/tasks

# Copy the bundled orchestration skill from cc-mirror installation
# This skill provides orchestration patterns and domain-specific guidance
# The skill is located in the npm global package at dist/skills/orchestration
RUN CC_MIRROR_PATH=$(npm root -g)/cc-mirror && \
    cp -r ${CC_MIRROR_PATH}/dist/skills/orchestration ${MCLAUDE_CONFIG_DIR}/config/skills/

# The .cc-mirror-managed marker indicates this is a managed skill
# Derived images can remove this marker and customize the skill files
# See: docs/features/team-mode.md for customization details

# Environment defaults
ENV NODE_ENV=production
ENV CC_MIRROR_SPLASH=0
ENV WORKSPACE_BASE=/workspace
ENV CLEANUP_AFTER_COMPLETE=true

WORKDIR /app

# Copy setup scripts (to be added by derived images)
COPY scripts/ /app/scripts/
RUN chmod +x /app/scripts/*.sh

# Copy queue worker application
COPY queue-worker/ /app/queue-worker/
WORKDIR /app/queue-worker
RUN npm ci --production=false && npm run build

WORKDIR /app

# Default entrypoint
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
