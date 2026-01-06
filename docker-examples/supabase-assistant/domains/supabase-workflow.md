# Supabase Operations Workflow

> **Load when**: Processing Supabase-related requests (database queries, migrations, storage, edge functions)

## Overview

This domain covers orchestration patterns for Supabase project management and database operations.

## Request Types

### Database Queries
- Inspect schema and table structures
- Execute SELECT queries for data exploration
- Aggregate and analyze data

### Schema Management
- Create/modify tables via migrations
- Add indexes and constraints
- Manage relationships

### Storage Operations
- List and manage buckets
- Upload/download files
- Set storage policies

### Edge Functions
- Deploy serverless functions
- View logs and debug
- Manage function configurations

## Workflow Patterns

### 1. Database Exploration

When asked to explore or understand a database:

1. **List all tables**: Get overview of schema
2. **Describe key tables**: Show columns, types, constraints
3. **Sample data**: Query a few rows from important tables
4. **Identify relationships**: Find foreign keys and joins
5. **Summarize findings**: Present clear overview

### 2. Data Analysis

When asked to analyze data:

1. **Understand the question**: Clarify what metrics/insights needed
2. **Identify relevant tables**: Which tables contain the data
3. **Build query incrementally**: Start simple, add complexity
4. **Execute and validate**: Check results make sense
5. **Present findings**: Tables, summaries, key insights

### 3. Schema Changes

When asked to modify schema:

1. **Document current state**: What exists now
2. **Plan changes**: What needs to change
3. **Create migration**: Use `supabase migration new`
4. **Review SQL**: Show the migration contents
5. **Apply carefully**: Use `supabase db push`

## Security Guidelines

- **Never expose keys in output**: Mask sensitive values
- **Prefer anon key**: Only use service key when necessary
- **Validate inputs**: Sanitize any user-provided values in SQL
- **Read before write**: Understand data before modifying

## Output Expectations

1. **Show your work**: Display queries executed
2. **Format results**: Use tables for data, code blocks for SQL
3. **Explain findings**: Don't just dump data, interpret it
4. **Suggest next steps**: What else might be useful to explore

## Error Recovery

When operations fail:
1. Capture the error message
2. Diagnose the likely cause
3. Suggest a fix or alternative approach
4. Retry with corrected approach
