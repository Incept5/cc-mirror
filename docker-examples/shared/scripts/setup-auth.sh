#!/bin/bash
set -e

echo "Setting up Claude authentication..."

CONFIG_DIR="${MCLAUDE_CONFIG_DIR:-/root/.cc-mirror/mc}/config"
mkdir -p "$CONFIG_DIR"

# Create settings.json with auth token and permissions
cat > "$CONFIG_DIR/settings.json" << EOF
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "${ANTHROPIC_AUTH_TOKEN:-}",
    "CLAUDE_CODE_TEAM_MODE": "${CLAUDE_CODE_TEAM_MODE:-1}",
    "CLAUDE_CODE_AGENT_TYPE": "${CLAUDE_CODE_AGENT_TYPE:-worker}",
    "CLAUDE_CODE_AGENT_ID": "${CLAUDE_CODE_AGENT_ID:-${WORKER_ID_PREFIX:-worker}-${HOSTNAME:-unknown}}"
  },
  "permissions": {
    "allow": [
      "Skill(orchestration)",
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)",
      "Grep(*)",
      "Task(*)",
      "WebFetch(*)",
      "WebSearch(*)"
    ]
  }
}
EOF

# Validate auth token is present
if [ -z "$ANTHROPIC_AUTH_TOKEN" ]; then
    echo "WARNING: ANTHROPIC_AUTH_TOKEN is not set!"
    echo "         mclaude will not be able to authenticate."
fi

echo "Auth configuration written to $CONFIG_DIR/settings.json"
