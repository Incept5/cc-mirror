#!/bin/bash
set -e

echo "Setting up Git and SSH..."

SSH_DIR="/root/.ssh"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

# Setup SSH private key if provided
if [ -n "$SSH_PRIVATE_KEY" ]; then
    echo "Configuring SSH private key from environment..."
    echo "$SSH_PRIVATE_KEY" > "$SSH_DIR/id_rsa"
    chmod 600 "$SSH_DIR/id_rsa"

    # Generate public key from private
    ssh-keygen -y -f "$SSH_DIR/id_rsa" > "$SSH_DIR/id_rsa.pub" 2>/dev/null || true

    echo "SSH key configured"
elif [ -f "$SSH_PRIVATE_KEY_PATH" ]; then
    echo "Configuring SSH private key from file: $SSH_PRIVATE_KEY_PATH"
    cp "$SSH_PRIVATE_KEY_PATH" "$SSH_DIR/id_rsa"
    chmod 600 "$SSH_DIR/id_rsa"

    # Generate public key from private
    ssh-keygen -y -f "$SSH_DIR/id_rsa" > "$SSH_DIR/id_rsa.pub" 2>/dev/null || true

    echo "SSH key configured"
else
    echo "WARNING: No SSH private key provided!"
    echo "         Git operations over SSH will fail."
fi

# Setup SSH config for GitHub
cat > "$SSH_DIR/config" << 'EOF'
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_rsa
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null

Host *
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
EOF
chmod 600 "$SSH_DIR/config"

# Configure git globals
git config --global user.email "${GIT_USER_EMAIL:-mclaude-bot@example.com}"
git config --global user.name "${GIT_USER_NAME:-mclaude-bot}"
git config --global init.defaultBranch main

# Setup GitHub CLI if token provided
if [ -n "$GH_TOKEN" ]; then
    echo "Configuring GitHub CLI..."
    echo "$GH_TOKEN" | gh auth login --with-token 2>/dev/null || true
    gh auth status || echo "Warning: GitHub CLI auth may have issues"
else
    echo "WARNING: GH_TOKEN not set - GitHub CLI operations will fail"
fi

echo "Git setup complete"
