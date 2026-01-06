# Code Review Bot - Specialized mclaude worker for automated code reviews
# Extends the base image with custom domain knowledge for code reviews

FROM mclaude-base:latest

# ============================================================
# SKILL CUSTOMIZATION via .cc-mirror-managed marker mechanism
# ============================================================
#
# The base image includes the bundled orchestration skill at:
#   /root/.cc-mirror/mc/config/skills/orchestration/
#
# This skill already includes domain patterns at:
#   references/domains/code-review.md
#   references/domains/testing.md
#   references/domains/software-development.md
#   ... and more
#
# To customize, we:
# 1. Remove the .cc-mirror-managed marker (prevents overwrites on updates)
# 2. Add/replace domain files in references/domains/
#
# See: docs/features/team-mode.md for full customization details

# Remove the managed marker to enable customization
RUN rm -f /root/.cc-mirror/mc/config/skills/orchestration/.cc-mirror-managed

# Add enhanced code review domain patterns
# This file EXTENDS the bundled code-review.md with company-specific standards
COPY domains/code-review-enhanced.md /root/.cc-mirror/mc/config/skills/orchestration/references/domains/code-review-enhanced.md

# ============================================================
# ENVIRONMENT - Agent configuration
# ============================================================

# This agent is a specialized worker (not a team lead)
ENV CLAUDE_CODE_AGENT_TYPE="worker"
ENV AGENT_SPECIALIZATION="code-review"

# Worker configuration
ENV WORKER_COUNT=1
ENV POLL_INTERVAL_MS=5000

# Entrypoint from base image handles startup
