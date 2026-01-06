# Docker Examples for mclaude

Production-ready Docker configurations for running mclaude (cc-mirror) as automated agents. These examples demonstrate how to containerize mclaude with custom skills, domain knowledge, and queue-based orchestration.

## Overview

| Example | Description | Use Case |
|---------|-------------|----------|
| [code-review-bot](./code-review-bot/) | Git repo worker with custom domain | Automated PR reviews |
| [supabase-assistant](./supabase-assistant/) | Non-repo worker with custom CLI skill | Database operations via Supabase CLI |

## Architecture

All examples share a common architecture:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ PostgreSQL      │────▶│ NestJS Queue    │────▶│ mclaude CLI     │
│ Request Queue   │     │ Worker          │     │ --print mode    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │                       ▼                       ▼
        │               ┌─────────────────┐     ┌─────────────────┐
        └──────────────▶│ PostgreSQL      │◀────│ Git Clone +     │
                        │ Results Table   │     │ Task Execution  │
                        └─────────────────┘     └─────────────────┘
```

### Components

- **PostgreSQL Queue**: `orchestration_requests` table holds pending tasks
- **NestJS Worker**: Polls queue, claims requests, spawns mclaude
- **mclaude CLI**: Runs in `--print` mode (non-interactive)
- **Results Table**: `orchestration_results` stores execution output

## Quick Start

### 1. Build the Base Image

```bash
cd shared
docker build -f base.Dockerfile -t mclaude-base:latest .
```

### 2. Choose an Example

```bash
cd code-review-bot
```

### 3. Configure Credentials

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 4. Start the Stack

```bash
docker-compose up -d
```

### 5. Submit a Request

```bash
# Connect to database
docker-compose exec db psql -U orchestration -d orchestration

# Insert a request
INSERT INTO orchestration_requests (repo_url, prompt) VALUES (
  'git@github.com:your-org/your-repo.git',
  'Your task description here'
);
```

## Customizing the Orchestration Skill

The base image includes cc-mirror's bundled **orchestration skill** which provides:
- Core orchestration identity ("The Conductor")
- Patterns: fan-out, pipeline, map-reduce, speculative, background
- Domain guides for: code-review, testing, documentation, devops, and more

### The `.cc-mirror-managed` Marker Mechanism

cc-mirror marks managed skills with a `.cc-mirror-managed` file. To customize:

1. **Remove the marker** (prevents overwrites on future updates)
2. **Add/replace domain files** in `references/domains/`
3. **Optionally modify `SKILL.md`** for identity changes

```dockerfile
# In your Dockerfile:

# Remove the managed marker to enable customization
RUN rm -f /root/.cc-mirror/mc/config/skills/orchestration/.cc-mirror-managed

# Add custom domain patterns
COPY domains/my-patterns.md /root/.cc-mirror/mc/config/skills/orchestration/references/domains/my-patterns.md
```

### Bundled Orchestration Skill Structure

```
/root/.cc-mirror/mc/config/skills/orchestration/
├── SKILL.md                    # Core identity and workflow
├── .cc-mirror-managed          # Marker file (remove to customize)
└── references/
    ├── guide.md                # User-facing guide
    ├── patterns.md             # Orchestration patterns
    ├── tools.md                # Tool reference
    ├── examples.md             # Usage examples
    └── domains/                # Domain-specific guides
        ├── code-review.md      # PR review, security audit
        ├── testing.md          # Test generation patterns
        ├── documentation.md    # Doc generation
        ├── software-development.md
        ├── devops.md
        ├── data-analysis.md
        ├── project-management.md
        └── research.md
```

### Customization Options

1. **Add a new domain file**: Create `domains/my-company.md` and copy to `references/domains/`
2. **Replace existing domain**: Override `code-review.md` with your version
3. **Modify identity**: Edit `SKILL.md` for significant behavior changes
4. **Extend references**: Add files to `references/` for additional guidance

### Example: Adding Company-Specific Review Standards

```bash
# Create custom domain file
cat > domains/acme-security.md << 'EOF'
# ACME Corp Security Standards

> **Load when**: Any security-related review

## Required Checks
- All API endpoints must use authentication middleware
- No raw SQL queries (use parameterized only)
- PII must be encrypted at rest
EOF

# Copy in Dockerfile
COPY domains/acme-security.md /root/.cc-mirror/mc/config/skills/orchestration/references/domains/acme-security.md
```

## Database Schema

### orchestration_requests (Input Queue)

```sql
CREATE TABLE orchestration_requests (
  id            UUID PRIMARY KEY,
  created_at    TIMESTAMPTZ,
  status        TEXT,          -- pending, processing, completed, failed
  repo_url      TEXT,          -- Optional: if provided, repo is cloned
  branch        TEXT DEFAULT 'main',
  prompt        TEXT NOT NULL,
  config        JSONB,         -- Optional: model, timeout, skill overrides
  metadata      JSONB,         -- Optional: injected as env vars to mclaude
  claimed_at    TIMESTAMPTZ,
  claimed_by    TEXT
);
```

**Notes**:
- `repo_url` is optional. If provided, the repository is cloned as the working directory. If omitted, mclaude runs in an empty workspace.
- `metadata` values are injected as environment variables (camelCase keys become SCREAMING_SNAKE_CASE).

### orchestration_results (Output)

```sql
CREATE TABLE orchestration_results (
  id            UUID PRIMARY KEY,
  request_id    UUID REFERENCES orchestration_requests(id),
  status        TEXT,          -- success, error, partial, timeout
  output        JSONB,         -- Full mclaude output
  pr_url        TEXT,          -- If a PR was created
  commit_sha    TEXT,          -- Latest commit
  duration_ms   INTEGER,
  error         TEXT
);
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_AUTH_TOKEN` | Claude Max subscription auth token |
| `SSH_PRIVATE_KEY` | SSH key for git clone operations |
| `GH_TOKEN` | GitHub personal access token |

### Worker Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_COUNT` | 1 | Parallel workers per container |
| `POLL_INTERVAL_MS` | 5000 | Queue polling interval |
| `MCLAUDE_TIMEOUT_MS` | 1800000 | Max execution time (30 min) |
| `CLEANUP_AFTER_COMPLETE` | true | Remove workspace after completion |
| `WORKSPACE_BASE` | /workspace | Base directory for cloned repos |

### Agent Identity

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_AGENT_TYPE` | "team-lead" or "worker" |
| `CLAUDE_CODE_AGENT_ID` | Unique identifier for this agent |
| `CLAUDE_CODE_TEAM_MODE` | "1" to enable team mode |

## Request Configuration

The `config` JSONB field accepts:

```json
{
  "model": "sonnet",           // haiku, sonnet, or opus
  "timeout_minutes": 15,       // Override default timeout
  "skill_overrides": {}        // Future: per-request skill config
}
```

## Monitoring

### Logs

```bash
# All containers
docker-compose logs -f

# Specific worker
docker-compose logs -f code-review-bot
```

### Queue Status

```sql
-- Pending requests
SELECT COUNT(*) FROM orchestration_requests WHERE status = 'pending';

-- Processing requests
SELECT id, claimed_by, claimed_at
FROM orchestration_requests
WHERE status = 'processing';

-- Recent results
SELECT request_id, status, duration_ms, created_at
FROM orchestration_results
ORDER BY created_at DESC
LIMIT 10;
```

### Stale Request Recovery

The database includes a function to release stuck requests:

```sql
SELECT release_stale_requests('30 minutes'::interval);
```

## Security Considerations

1. **Credentials**: Never commit `.env` files. Use secrets management in production.

2. **Network**: The containers don't expose ports by default. Database is internal only.

3. **Permissions**: mclaude runs with pre-approved tools (`allowedTools: '*'`). Review the settings.json if you need restrictions.

4. **SSH Keys**: Use dedicated deploy keys with minimal permissions.

5. **GitHub Tokens**: Use fine-grained tokens with only required scopes.

## Production Deployment

### Kubernetes

Convert docker-compose to Kubernetes manifests:

```bash
kompose convert -f docker-compose.yml
```

Key considerations:
- Use Kubernetes Secrets for credentials
- Add resource limits
- Configure health checks
- Use PersistentVolumeClaims for database

### Scaling

```bash
# Scale workers horizontally
docker-compose up -d --scale worker-1=5

# Or add more worker services in docker-compose.yml
```

Each worker needs:
- Unique `CLAUDE_CODE_AGENT_ID`
- Own workspace volume

### High Availability

For production HA:
- Use managed PostgreSQL (RDS, Cloud SQL)
- Run multiple worker replicas
- Add Redis for faster queue operations (future enhancement)
- Implement proper health checks

## Troubleshooting

### Worker not processing requests

1. Check database connection:
   ```bash
   docker-compose exec worker-1 node -e "require('pg').Client({connectionString: process.env.DATABASE_URL}).connect().then(() => console.log('OK'))"
   ```

2. Check for pending requests:
   ```sql
   SELECT * FROM orchestration_requests WHERE status = 'pending' LIMIT 5;
   ```

3. Check worker logs:
   ```bash
   docker-compose logs --tail=50 worker-1
   ```

### Authentication failures

1. Verify token is set:
   ```bash
   docker-compose exec worker-1 echo $ANTHROPIC_AUTH_TOKEN | head -c 20
   ```

2. Test SSH:
   ```bash
   docker-compose exec worker-1 ssh -T git@github.com
   ```

3. Test GitHub CLI:
   ```bash
   docker-compose exec worker-1 gh auth status
   ```

### Timeout issues

1. Increase timeout in request config:
   ```sql
   UPDATE orchestration_requests
   SET config = '{"timeout_minutes": 60}'
   WHERE id = 'your-request-id';
   ```

2. Or increase default in environment:
   ```yaml
   environment:
     - MCLAUDE_TIMEOUT_MS=3600000  # 1 hour
   ```

## License

MIT
