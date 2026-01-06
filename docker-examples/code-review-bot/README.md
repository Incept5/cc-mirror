# Code Review Bot

An automated code review agent powered by mclaude. This example demonstrates how to customize mclaude with a specialized skill for security-focused code reviews.

## Features

- **Security-First Reviews**: Automatically checks for OWASP Top 10 vulnerabilities
- **Actionable Feedback**: Every issue includes a concrete fix suggestion
- **Queue-Based**: Processes review requests from a PostgreSQL queue
- **Customizable**: Modify the skill and domain knowledge for your needs

## Quick Start

### 1. Prerequisites

- Docker and Docker Compose
- Claude Max subscription (for ANTHROPIC_AUTH_TOKEN)
- GitHub personal access token
- SSH key for git operations

### 2. Build Base Image

```bash
cd ../shared
docker build -f base.Dockerfile -t mclaude-base:latest .
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 4. Start the Stack

```bash
docker-compose up -d
```

### 5. Submit a Review Request

```bash
# Connect to the database
docker-compose exec db psql -U orchestration -d orchestration

# Insert a review request
INSERT INTO orchestration_requests (repo_url, branch, prompt) VALUES (
  'git@github.com:your-org/your-repo.git',
  'feature/new-feature',
  'Review the changes in this branch for security issues and code quality'
);
```

### 6. Monitor Progress

```bash
# Watch the worker logs
docker-compose logs -f code-review-bot

# Check results
docker-compose exec db psql -U orchestration -d orchestration -c \
  "SELECT id, status, output->>'stdout' as review FROM orchestration_results ORDER BY created_at DESC LIMIT 1;"
```

## Customization

### Using the `.cc-mirror-managed` Mechanism

This example uses cc-mirror's bundled orchestration skill, which already includes comprehensive code review patterns at `references/domains/code-review.md`. We extend it with custom domain files.

**How it works:**

1. The base image copies the bundled orchestration skill
2. The Dockerfile removes `.cc-mirror-managed` to enable customization
3. Custom domain files in `domains/` are copied to `references/domains/`

### Customizing Review Patterns

Edit `domains/code-review-enhanced.md` to:

- Add company-specific security requirements
- Include framework-specific checks (React, Django, etc.)
- Customize the output format
- Add domain-specific review criteria

### Adding More Domain Files

Create additional domain files in the `domains/` directory:

```
domains/
├── code-review-enhanced.md     # Existing - enhanced patterns
├── typescript-security.md      # Add TypeScript-specific checks
└── api-review.md               # Add API design patterns
```

Then update the Dockerfile:

```dockerfile
COPY domains/typescript-security.md /root/.cc-mirror/mc/config/skills/orchestration/references/domains/typescript-security.md
```

### Project-Level Context

The `domain/CLAUDE.md` file provides project-specific context. Customize it to:

- Define your code standards
- Specify priority areas for review
- Set expectations for output format

### Replacing Bundled Domains

To completely replace a bundled domain file:

```dockerfile
# Replace the bundled code-review.md with your version
COPY domains/code-review.md /root/.cc-mirror/mc/config/skills/orchestration/references/domains/code-review.md
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_AUTH_TOKEN` | Claude Max auth token | Required |
| `SSH_PRIVATE_KEY` | SSH key for git operations | Required |
| `GH_TOKEN` | GitHub personal access token | Required |
| `WORKER_COUNT` | Number of parallel workers | 1 |
| `POLL_INTERVAL_MS` | Queue polling interval | 5000 |
| `MCLAUDE_TIMEOUT_MS` | Max execution time | 1800000 (30 min) |
| `CLEANUP_AFTER_COMPLETE` | Remove workspace after review | true |

## Request Schema

```sql
INSERT INTO orchestration_requests (
  repo_url,     -- Git repository URL
  branch,       -- Branch to review (default: 'main')
  prompt,       -- Review instructions
  config        -- Optional JSON config
) VALUES (
  'git@github.com:org/repo.git',
  'feature/auth-refactor',
  'Review this PR for security issues. Focus on authentication changes.',
  '{"model": "sonnet", "timeout_minutes": 15}'
);
```

## Result Schema

```sql
SELECT
  r.id,
  r.status,          -- 'success', 'error', 'partial', 'timeout'
  r.output,          -- Full review output (JSON)
  r.pr_url,          -- PR URL if created
  r.duration_ms,     -- Execution time
  r.error            -- Error message if failed
FROM orchestration_results r
WHERE r.request_id = 'your-request-id';
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Request Queue  │────▶│  Queue Worker   │────▶│  mclaude CLI    │
│  (PostgreSQL)   │     │  (NestJS)       │     │  --print mode   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │                        │
                               ▼                        ▼
                        ┌─────────────────┐     ┌─────────────────┐
                        │  Result Table   │     │  Git Clone +    │
                        │  (PostgreSQL)   │◀────│  Review Output  │
                        └─────────────────┘     └─────────────────┘
```

## Troubleshooting

### Worker not processing requests

1. Check logs: `docker-compose logs code-review-bot`
2. Verify database connection: `docker-compose exec db psql -U orchestration -c "SELECT 1"`
3. Check for pending requests: `SELECT * FROM orchestration_requests WHERE status = 'pending'`

### Authentication failures

1. Verify `ANTHROPIC_AUTH_TOKEN` is set correctly
2. Check SSH key is valid: `ssh -T git@github.com`
3. Verify GitHub token has required scopes

### Timeout issues

1. Increase `MCLAUDE_TIMEOUT_MS` for large repositories
2. Add `{"timeout_minutes": 60}` to request config
3. Consider breaking large reviews into smaller chunks

## License

MIT
