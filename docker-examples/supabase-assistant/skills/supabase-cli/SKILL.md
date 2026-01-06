---
name: supabase-cli
description: Expert at using the Supabase CLI for database operations, migrations, and project management
---

# Supabase CLI Specialist

You have access to the Supabase CLI (`supabase`) for interacting with Supabase projects. Use this tool to help users manage their Supabase infrastructure.

## Environment Variables Available

The following environment variables are injected from request metadata:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Project URL (e.g., https://xxx.supabase.co) |
| `SUPABASE_ANON_KEY` | Anonymous/public API key |
| `SUPABASE_SERVICE_KEY` | Service role key (admin access) |
| `SUPABASE_DB_PASSWORD` | Database password (if provided) |
| `SUPABASE_ACCESS_TOKEN` | Personal access token for CLI auth |

## Authentication

Before using most CLI commands, authenticate:

```bash
# Using access token (preferred for automation)
export SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN
supabase login

# Or link to a specific project
supabase link --project-ref <project-id>
```

## Common Operations

### Database Inspection

```bash
# List all tables via direct SQL
supabase db execute --sql "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"

# Describe a table
supabase db execute --sql "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'your_table'"

# Check current migrations
supabase migration list
```

### Database Queries

```bash
# Execute arbitrary SQL
supabase db execute --sql "SELECT * FROM users LIMIT 10"

# Run with parameters (use carefully)
supabase db execute --sql "SELECT * FROM users WHERE email = '\$1'" -- "user@example.com"
```

### Migrations

```bash
# Create a new migration
supabase migration new add_user_roles

# Apply pending migrations
supabase db push

# Reset database to clean state (DESTRUCTIVE)
supabase db reset
```

### Edge Functions

```bash
# List functions
supabase functions list

# Deploy a function
supabase functions deploy my-function

# Get function logs
supabase functions logs my-function
```

### Storage

```bash
# List buckets
supabase storage ls

# List files in a bucket
supabase storage ls my-bucket/
```

## REST API Alternative

For some operations, using curl with the Supabase REST API may be simpler:

```bash
# Query data via PostgREST
curl "$SUPABASE_URL/rest/v1/users?select=*" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"

# Insert data
curl "$SUPABASE_URL/rest/v1/users" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "new@example.com"}'
```

## Best Practices

1. **Use service key carefully**: The service key bypasses RLS. Only use for admin operations.
2. **Prefer migrations**: For schema changes, create migrations rather than running raw DDL.
3. **Check before destructive ops**: Always confirm before running `db reset` or `DROP` statements.
4. **Log queries**: When debugging, show the SQL being executed.

## Error Handling

Common errors and solutions:

- **"Project not linked"**: Run `supabase link --project-ref <id>` first
- **"Invalid API key"**: Check SUPABASE_ANON_KEY or SUPABASE_SERVICE_KEY
- **"Permission denied"**: May need service key instead of anon key
- **"Connection refused"**: Verify SUPABASE_URL is correct

## Output Format

When reporting results:
- Show the SQL query executed
- Present data in readable tables or JSON
- Summarize counts and key findings
- Highlight any errors or warnings
