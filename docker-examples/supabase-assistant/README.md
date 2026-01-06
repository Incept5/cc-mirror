# Supabase Assistant

An AI assistant powered by mclaude that can interact with your Supabase projects. This example demonstrates:

- **Non-repo workflows**: No git clone required, uses empty workspace
- **Custom CLI tools**: Installs and uses the Supabase CLI
- **Per-request credentials**: Supabase URL/keys passed via request metadata
- **Custom skills**: Teaches Claude how to use the Supabase CLI effectively

## Features

- Query and explore Supabase databases
- Execute SQL via the Supabase CLI
- Manage migrations and schema changes
- Interact with Storage and Edge Functions
- Analyze data and provide insights

## Quick Start

### 1. Build Base Image

```bash
cd ../shared
docker build -f base.Dockerfile -t mclaude-base:latest .
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env - only ANTHROPIC_AUTH_TOKEN is required
```

### 3. Start the Stack

```bash
docker-compose up -d
```

### 4. Submit a Request

```bash
docker-compose exec db psql -U orchestration -d orchestration << 'EOF'
INSERT INTO orchestration_requests (prompt, metadata) VALUES (
  'List all tables in my Supabase project and show me the schema for each',
  '{
    "supabaseUrl": "https://yourproject.supabase.co",
    "supabaseAnonKey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "supabaseServiceKey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }'::jsonb
);
EOF
```

### 5. Monitor Progress

```bash
docker-compose logs -f supabase-assistant
```

### 6. Check Results

```bash
docker-compose exec db psql -U orchestration -d orchestration -c \
  "SELECT id, status, output->>'stdout' as result FROM orchestration_results ORDER BY created_at DESC LIMIT 1;"
```

## How Metadata Works

Request metadata is converted to environment variables and injected into the mclaude process:

| Metadata Key | Environment Variable |
|--------------|---------------------|
| `supabaseUrl` | `SUPABASE_URL` |
| `supabaseAnonKey` | `SUPABASE_ANON_KEY` |
| `supabaseServiceKey` | `SUPABASE_SERVICE_KEY` |
| `supabaseDbPassword` | `SUPABASE_DB_PASSWORD` |
| `supabaseAccessToken` | `SUPABASE_ACCESS_TOKEN` |

Keys are converted from camelCase to SCREAMING_SNAKE_CASE automatically.

## Example Requests

### Explore Database Schema

```sql
INSERT INTO orchestration_requests (prompt, metadata) VALUES (
  'Show me all tables and their relationships in my database',
  '{"supabaseUrl": "...", "supabaseServiceKey": "..."}'::jsonb
);
```

### Analyze Data

```sql
INSERT INTO orchestration_requests (prompt, metadata) VALUES (
  'How many users signed up in the last 30 days? Show me the daily breakdown.',
  '{"supabaseUrl": "...", "supabaseServiceKey": "..."}'::jsonb
);
```

### Create Migration

```sql
INSERT INTO orchestration_requests (prompt, metadata) VALUES (
  'Create a migration to add a "role" column to the users table with values admin, user, guest',
  '{"supabaseUrl": "...", "supabaseAccessToken": "..."}'::jsonb
);
```

### Debug Edge Function

```sql
INSERT INTO orchestration_requests (prompt, metadata) VALUES (
  'Show me the recent logs for my send-email edge function and identify any errors',
  '{"supabaseUrl": "...", "supabaseAccessToken": "..."}'::jsonb
);
```

## Customization

### Adding More CLI Tools

Edit the Dockerfile to install additional tools:

```dockerfile
# Example: Add jq for JSON processing
RUN apk add --no-cache jq

# Example: Add PostgreSQL client
RUN apk add --no-cache postgresql-client
```

### Extending the Skill

Edit `skills/supabase-cli/SKILL.md` to add more CLI patterns or examples.

### Adding Domain Workflows

Create additional domain files in `domains/`:

```
domains/
├── supabase-workflow.md      # Existing
├── migration-patterns.md     # Add migration best practices
└── rls-policies.md          # Add RLS policy guidance
```

## Security Notes

1. **Credentials in metadata**: Credentials are stored in the database. Ensure your PostgreSQL instance is secured.

2. **Service key exposure**: The service key bypasses Row Level Security. Only include it when admin access is needed.

3. **Workspace cleanup**: Workspaces are cleaned up after each request by default. Set `CLEANUP_AFTER_COMPLETE=false` for debugging.

4. **Network isolation**: The worker container has network access to call Supabase APIs. Consider network policies in production.

## Troubleshooting

### "Project not linked" error

The CLI needs to be linked to a project for some operations. Include `supabaseAccessToken` in metadata for CLI auth.

### "Invalid API key" error

Verify your anon/service keys are correct. Check they match the project URL.

### Worker not processing

1. Check logs: `docker-compose logs supabase-assistant`
2. Verify database connection: `docker-compose exec db psql -U orchestration -c "SELECT 1"`
3. Check for pending requests: `SELECT * FROM orchestration_requests WHERE status = 'pending'`

## License

MIT
