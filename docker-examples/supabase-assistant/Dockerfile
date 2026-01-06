# Supabase Assistant - mclaude worker with Supabase CLI integration
# Demonstrates non-repo workflows with custom CLI tools and per-request credentials

FROM mclaude-base:latest

# ============================================================
# INSTALL SUPABASE CLI
# ============================================================

# Install Supabase CLI via npm (global)
RUN npm install -g supabase

# Verify installation
RUN supabase --version

# ============================================================
# SKILL CUSTOMIZATION via .cc-mirror-managed marker mechanism
# ============================================================
#
# The base image includes the bundled orchestration skill at:
#   /root/.cc-mirror/mc/config/skills/orchestration/
#
# We customize by:
# 1. Remove the .cc-mirror-managed marker (prevents overwrites on updates)
# 2. Add custom domain file for Supabase workflows
# 3. Add custom skill for Supabase CLI usage

# Remove the managed marker to enable customization
RUN rm -f /root/.cc-mirror/mc/config/skills/orchestration/.cc-mirror-managed

# Add Supabase workflow domain patterns
COPY domains/supabase-workflow.md /root/.cc-mirror/mc/config/skills/orchestration/references/domains/supabase-workflow.md

# ============================================================
# CUSTOM SKILL: Supabase CLI
# ============================================================
#
# This is a user-managed skill (no .cc-mirror-managed marker)
# It teaches Claude how to use the Supabase CLI effectively

COPY skills/supabase-cli/ /root/.cc-mirror/mc/config/skills/supabase-cli/

# ============================================================
# ENVIRONMENT - Agent configuration
# ============================================================

# This agent is a specialized worker for Supabase operations
ENV CLAUDE_CODE_AGENT_TYPE="worker"
ENV AGENT_SPECIALIZATION="supabase"

# Worker configuration
ENV WORKER_COUNT=1
ENV POLL_INTERVAL_MS=5000

# Supabase CLI environment (credentials come from request metadata)
# These are placeholders - actual values injected at runtime from metadata
ENV SUPABASE_ACCESS_TOKEN=""

# Entrypoint from base image handles startup
