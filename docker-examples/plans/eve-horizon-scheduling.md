# eve-horizon Scheduling Architecture

> **Status**: Brainstorming
> **Focus**: Cron-style scheduling for periodic orchestration flows

## Core Requirements

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   SCHEDULING REQUIREMENTS                                       │
│                                                                 │
│   1. User/Org scoped - schedules belong to a user in an org    │
│   2. CLI manageable - agents can CRUD schedules                │
│   3. Context preserved - runs with creator's auth/permissions   │
│   4. Standard cron syntax + human-friendly intervals           │
│   5. Execution history and monitoring                          │
│   6. Timezone support                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SCHEDULING FLOW                                     │
│                                                                             │
│   eve schedule create                                                       │
│   --name "daily-review"                                                     │
│   --cron "0 9 * * *"                                                       │
│   --worker-type code-review                                                │
│   --prompt "Review PRs from yesterday"                                     │
│                                                                             │
│            │                                                                │
│            ▼                                                                │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                    eve.schedules table                              │  │
│   │                                                                     │  │
│   │  id: uuid                                                          │  │
│   │  org_id: acme-corp                                                 │  │
│   │  user_id: user-123                                                 │  │
│   │  name: "daily-review"                                              │  │
│   │  cron_expression: "0 9 * * *"                                      │  │
│   │  worker_type: "code-review"                                        │  │
│   │  prompt: "Review PRs from yesterday"                               │  │
│   │  next_run_at: 2025-01-07 09:00:00 UTC                              │  │
│   │                                                                     │  │
│   └───────────────────────────────┬─────────────────────────────────────┘  │
│                                   │                                        │
│                                   │  pg_cron (every minute)               │
│                                   ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                    Scheduler Function                               │  │
│   │                                                                     │  │
│   │  SELECT * FROM eve.schedules                                       │  │
│   │  WHERE next_run_at <= now()                                        │  │
│   │    AND enabled = true                                              │  │
│   │                                                                     │  │
│   │  FOR EACH: Insert into orchestration_requests                      │  │
│   │            with schedule owner's org_id/user_id                    │  │
│   │                                                                     │  │
│   └───────────────────────────────┬─────────────────────────────────────┘  │
│                                   │                                        │
│                                   ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                    orchestration_requests                           │  │
│   │                                                                     │  │
│   │  org_id: acme-corp        (from schedule)                          │  │
│   │  user_id: user-123        (from schedule)                          │  │
│   │  worker_type: code-review                                          │  │
│   │  prompt: "Review PRs..."                                           │  │
│   │  context: {schedule_id: "...", triggered_at: "..."}                │  │
│   │                                                                     │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Schedules table
CREATE TABLE eve.schedules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),

    -- Ownership (who created this, runs with their context)
    org_id          UUID NOT NULL REFERENCES eve.organizations(id),
    user_id         UUID NOT NULL REFERENCES auth.users(id),

    -- Identity
    name            TEXT NOT NULL,
    description     TEXT,

    -- Schedule definition
    cron_expression TEXT NOT NULL,           -- '0 9 * * *' or '@daily'
    timezone        TEXT DEFAULT 'UTC',      -- 'America/New_York'

    -- What to run
    worker_type     TEXT NOT NULL REFERENCES eve.worker_types(id),
    prompt          TEXT NOT NULL,
    repo_url        TEXT,
    branch          TEXT DEFAULT 'main',
    context         JSONB DEFAULT '{}',      -- Additional context for the request
    config          JSONB DEFAULT '{}',      -- model, timeout, etc.

    -- State
    enabled         BOOLEAN DEFAULT true,
    next_run_at     TIMESTAMPTZ,
    last_run_at     TIMESTAMPTZ,
    last_run_status TEXT,                    -- 'success', 'failed', 'running'

    -- Stats
    run_count       INTEGER DEFAULT 0,
    success_count   INTEGER DEFAULT 0,
    failure_count   INTEGER DEFAULT 0,

    -- Constraints
    UNIQUE (org_id, name)
);

-- RLS: Users can only see/manage their org's schedules
ALTER TABLE eve.schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_schedules" ON eve.schedules
    USING (org_id IN (
        SELECT org_id FROM eve.org_members
        WHERE user_id = auth.uid()
    ));

-- Index for scheduler query
CREATE INDEX idx_schedules_next_run
    ON eve.schedules(next_run_at)
    WHERE enabled = true;

-- Schedule execution history
CREATE TABLE eve.schedule_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id     UUID NOT NULL REFERENCES eve.schedules(id),
    request_id      UUID REFERENCES eve.orchestration_requests(id),

    started_at      TIMESTAMPTZ DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    status          TEXT DEFAULT 'pending',  -- pending, running, success, failed, skipped

    error           TEXT,

    -- Denormalized for queries
    org_id          UUID NOT NULL,
    scheduled_for   TIMESTAMPTZ NOT NULL     -- When it was supposed to run
);

CREATE INDEX idx_schedule_runs_schedule ON eve.schedule_runs(schedule_id, started_at DESC);
```

---

## Cron Expression Support

```
┌─────────────────────────────────────────────────────────────────┐
│                    CRON SYNTAX                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌───────────── minute (0-59)                                 │
│   │ ┌─────────── hour (0-23)                                   │
│   │ │ ┌───────── day of month (1-31)                           │
│   │ │ │ ┌─────── month (1-12)                                  │
│   │ │ │ │ ┌───── day of week (0-6, Sun=0)                      │
│   │ │ │ │ │                                                     │
│   * * * * *                                                     │
│                                                                 │
│   EXAMPLES:                                                     │
│   ─────────                                                     │
│   0 9 * * *        Every day at 9:00 AM                        │
│   0 9 * * 1-5      Weekdays at 9:00 AM                         │
│   */15 * * * *     Every 15 minutes                            │
│   0 0 1 * *        First of each month at midnight             │
│   0 */4 * * *      Every 4 hours                               │
│                                                                 │
│   SHORTCUTS (parsed to cron):                                   │
│   ─────────────────────────────                                 │
│   @hourly          0 * * * *                                   │
│   @daily           0 0 * * *                                   │
│   @weekly          0 0 * * 0                                   │
│   @monthly         0 0 1 * *                                   │
│   @yearly          0 0 1 1 *                                   │
│                                                                 │
│   HUMAN READABLE (parsed to cron):                              │
│   ────────────────────────────────                              │
│   "every 15 minutes"                                           │
│   "every day at 9am"                                           │
│   "every monday at 10:30"                                      │
│   "first day of month at midnight"                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Scheduler Implementation

### pg_cron Job (runs every minute)

```sql
-- Create the scheduler function
CREATE OR REPLACE FUNCTION eve.process_schedules()
RETURNS void AS $$
DECLARE
    v_schedule RECORD;
    v_request_id UUID;
    v_next_run TIMESTAMPTZ;
BEGIN
    -- Find all schedules that are due
    FOR v_schedule IN
        SELECT *
        FROM eve.schedules
        WHERE enabled = true
          AND next_run_at <= now()
        FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            -- Create the orchestration request
            INSERT INTO eve.orchestration_requests (
                org_id,
                user_id,
                worker_type,
                prompt,
                repo_url,
                branch,
                context,
                config,
                status
            ) VALUES (
                v_schedule.org_id,
                v_schedule.user_id,
                v_schedule.worker_type,
                v_schedule.prompt,
                v_schedule.repo_url,
                v_schedule.branch,
                v_schedule.context || jsonb_build_object(
                    'schedule_id', v_schedule.id,
                    'schedule_name', v_schedule.name,
                    'triggered_at', now()
                ),
                v_schedule.config,
                'pending'
            )
            RETURNING id INTO v_request_id;

            -- Record the run
            INSERT INTO eve.schedule_runs (
                schedule_id,
                request_id,
                org_id,
                scheduled_for,
                status
            ) VALUES (
                v_schedule.id,
                v_request_id,
                v_schedule.org_id,
                v_schedule.next_run_at,
                'pending'
            );

            -- Calculate next run time
            v_next_run := eve.calculate_next_run(
                v_schedule.cron_expression,
                v_schedule.timezone
            );

            -- Update schedule
            UPDATE eve.schedules
            SET last_run_at = now(),
                last_run_status = 'running',
                next_run_at = v_next_run,
                run_count = run_count + 1,
                updated_at = now()
            WHERE id = v_schedule.id;

        EXCEPTION WHEN OTHERS THEN
            -- Log error but continue processing other schedules
            INSERT INTO eve.schedule_runs (
                schedule_id,
                org_id,
                scheduled_for,
                status,
                error
            ) VALUES (
                v_schedule.id,
                v_schedule.org_id,
                v_schedule.next_run_at,
                'failed',
                SQLERRM
            );

            UPDATE eve.schedules
            SET last_run_status = 'failed',
                failure_count = failure_count + 1,
                next_run_at = eve.calculate_next_run(
                    v_schedule.cron_expression,
                    v_schedule.timezone
                ),
                updated_at = now()
            WHERE id = v_schedule.id;
        END;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Schedule to run every minute
SELECT cron.schedule(
    'eve-scheduler',
    '* * * * *',
    'SELECT eve.process_schedules()'
);
```

### Calculate Next Run Time

```sql
-- Helper function to calculate next run time from cron expression
CREATE OR REPLACE FUNCTION eve.calculate_next_run(
    p_cron TEXT,
    p_timezone TEXT DEFAULT 'UTC'
)
RETURNS TIMESTAMPTZ AS $$
DECLARE
    v_next TIMESTAMPTZ;
BEGIN
    -- Use pg_cron's internal parser
    -- This is a simplified version - real implementation would use
    -- a proper cron parser library or extension

    -- For now, delegate to a helper that handles cron parsing
    SELECT eve.parse_cron_next(p_cron, now() AT TIME ZONE p_timezone)
           AT TIME ZONE p_timezone
    INTO v_next;

    RETURN v_next;
END;
$$ LANGUAGE plpgsql;
```

---

## CLI Commands

```bash
# ============================================
# SCHEDULE MANAGEMENT
# ============================================

# List all schedules for current org
eve schedule list
# Output:
# ID        NAME           CRON          NEXT RUN              STATUS
# abc123    daily-review   0 9 * * *     2025-01-07 09:00 UTC  enabled
# def456    weekly-report  0 0 * * 1     2025-01-13 00:00 UTC  enabled
# ghi789    hourly-check   0 * * * *     2025-01-06 15:00 UTC  disabled

# Create a new schedule
eve schedule create \
  --name "daily-code-review" \
  --cron "0 9 * * 1-5" \
  --timezone "America/New_York" \
  --worker-type code-review \
  --prompt "Review all open PRs and provide feedback" \
  --repo-url "git@github.com:acme/api.git" \
  --context '{"review_type": "daily"}'

# Create with human-readable schedule
eve schedule create \
  --name "weekly-report" \
  --schedule "every monday at 9am" \
  --worker-type general \
  --prompt "Generate weekly project status report"

# Get schedule details
eve schedule get --id abc123
# Or by name
eve schedule get --name "daily-review"

# Update a schedule
eve schedule update \
  --id abc123 \
  --cron "0 10 * * 1-5" \
  --prompt "Updated prompt here"

# Enable/disable
eve schedule enable --id abc123
eve schedule disable --id abc123

# Delete a schedule
eve schedule delete --id abc123

# ============================================
# EXECUTION HISTORY
# ============================================

# View recent runs for a schedule
eve schedule runs --id abc123 --limit 10
# Output:
# RUN ID    SCHEDULED FOR         STATUS    DURATION    REQUEST ID
# run-1     2025-01-06 09:00 UTC  success   45.2s       req-abc
# run-2     2025-01-05 09:00 UTC  success   38.1s       req-def
# run-3     2025-01-04 09:00 UTC  failed    -           -

# View all runs across schedules
eve schedule runs --all --since "7 days ago"

# Get details of a specific run
eve schedule run-details --run-id run-1

# ============================================
# TESTING & DEBUGGING
# ============================================

# Trigger a schedule immediately (for testing)
eve schedule trigger --id abc123

# Validate cron expression
eve schedule validate-cron "0 9 * * 1-5"
# Output: Valid. Next 5 runs:
#   2025-01-07 09:00 UTC (Tue)
#   2025-01-08 09:00 UTC (Wed)
#   2025-01-09 09:00 UTC (Thu)
#   2025-01-10 09:00 UTC (Fri)
#   2025-01-13 09:00 UTC (Mon)

# Parse human-readable schedule
eve schedule parse "every weekday at 9am EST"
# Output: 0 9 * * 1-5 (America/New_York)
```

---

## CLI Implementation

```typescript
// eve-cli schedule commands

interface Schedule {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  cron_expression: string;
  timezone: string;
  worker_type: string;
  prompt: string;
  repo_url?: string;
  context?: Record<string, any>;
  enabled: boolean;
  next_run_at: string;
}

// eve schedule create
async function createSchedule(opts: CreateScheduleOpts) {
  // Parse human-readable schedule if provided
  const cronExpression = opts.schedule
    ? parseCronExpression(opts.schedule)
    : opts.cron;

  // Validate cron expression
  if (!isValidCron(cronExpression)) {
    throw new Error(`Invalid cron expression: ${cronExpression}`);
  }

  // Calculate first run time
  const nextRunAt = calculateNextRun(cronExpression, opts.timezone || 'UTC');

  // Insert into database (inherits org_id/user_id from env)
  const result = await db.query(`
    INSERT INTO eve.schedules (
      org_id, user_id, name, cron_expression, timezone,
      worker_type, prompt, repo_url, branch, context, config, next_run_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
    )
    RETURNING *
  `, [
    process.env.EVE_ORG_ID,
    process.env.EVE_USER_ID,
    opts.name,
    cronExpression,
    opts.timezone || 'UTC',
    opts.workerType,
    opts.prompt,
    opts.repoUrl,
    opts.branch || 'main',
    opts.context || {},
    opts.config || {},
    nextRunAt,
  ]);

  console.log(JSON.stringify({ schedule: result.rows[0] }));
}

// eve schedule list
async function listSchedules() {
  const result = await db.query(`
    SELECT id, name, cron_expression, timezone, worker_type,
           enabled, next_run_at, last_run_at, last_run_status,
           run_count, success_count, failure_count
    FROM eve.schedules
    WHERE org_id = $1
    ORDER BY name
  `, [process.env.EVE_ORG_ID]);

  console.log(JSON.stringify({ schedules: result.rows }));
}

// eve schedule trigger (immediate execution)
async function triggerSchedule(scheduleId: string) {
  const schedule = await db.query(
    'SELECT * FROM eve.schedules WHERE id = $1 AND org_id = $2',
    [scheduleId, process.env.EVE_ORG_ID]
  );

  if (!schedule.rows[0]) {
    throw new Error('Schedule not found');
  }

  const s = schedule.rows[0];

  // Create request with schedule context
  const request = await db.query(`
    INSERT INTO eve.orchestration_requests (
      org_id, user_id, worker_type, prompt, repo_url, branch, context, config
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [
    s.org_id,
    s.user_id,
    s.worker_type,
    s.prompt,
    s.repo_url,
    s.branch,
    {
      ...s.context,
      schedule_id: s.id,
      schedule_name: s.name,
      triggered_at: new Date().toISOString(),
      manual_trigger: true,
    },
    s.config,
  ]);

  // Record the run
  await db.query(`
    INSERT INTO eve.schedule_runs (schedule_id, request_id, org_id, scheduled_for, status)
    VALUES ($1, $2, $3, now(), 'pending')
  `, [s.id, request.rows[0].id, s.org_id]);

  console.log(JSON.stringify({
    triggered: true,
    request_id: request.rows[0].id,
  }));
}
```

---

## Use Cases

### 1. Daily Code Review

```bash
eve schedule create \
  --name "daily-pr-review" \
  --cron "0 9 * * 1-5" \
  --timezone "America/New_York" \
  --worker-type code-review \
  --prompt "Review all open PRs. Focus on:
    - Security vulnerabilities
    - Performance issues
    - Code style violations
    Post comments on each PR with findings." \
  --repo-url "git@github.com:acme/api.git"
```

### 2. Weekly Status Report

```bash
eve schedule create \
  --name "weekly-status" \
  --schedule "every monday at 9am" \
  --worker-type general \
  --prompt "Generate a weekly status report including:
    - Commits from the past week
    - PRs merged
    - Open issues
    - Blockers identified
    Post to #engineering Slack channel." \
  --context '{"slack_channel": "C123456"}'
```

### 3. Nightly Data Sync

```bash
eve schedule create \
  --name "nightly-sync" \
  --cron "0 2 * * *" \
  --worker-type data \
  --prompt "Run the nightly data synchronization:
    1. Export from production database
    2. Transform data
    3. Load into analytics warehouse
    4. Verify row counts match" \
  --context '{"source_db": "prod", "target_db": "analytics"}'
```

### 4. Hourly Health Check

```bash
eve schedule create \
  --name "health-check" \
  --cron "0 * * * *" \
  --worker-type general \
  --prompt "Check system health:
    - API response times
    - Database connections
    - Queue depths
    - Error rates
    Alert if anything is abnormal." \
  --context '{"alert_channel": "C789012"}'
```

### 5. Monthly Security Audit

```bash
eve schedule create \
  --name "security-audit" \
  --cron "0 0 1 * *" \
  --worker-type code-review \
  --prompt "Perform monthly security audit:
    - Scan for dependency vulnerabilities
    - Check for exposed secrets
    - Review access permissions
    - Audit API endpoints
    Generate report and post to security team." \
  --repo-url "git@github.com:acme/api.git" \
  --context '{"audit_type": "monthly", "report_to": "security@acme.com"}'
```

---

## Orchestrator Integration

Schedules can also be managed by orchestrators as part of project workflows:

```markdown
# In an orchestrator SKILL.md

## Setting Up Recurring Tasks

When a project needs recurring work (e.g., daily reviews, weekly syncs),
create schedules that will trigger automatically:

```bash
# Create a schedule for daily progress checks
eve schedule create \
  --name "project-${PROJECT_ID}-daily-check" \
  --cron "0 9 * * 1-5" \
  --worker-type general \
  --prompt "Check progress on project ${PROJECT_NAME}:
    - Review completed tasks
    - Identify blockers
    - Update project plan if needed" \
  --context '{"project_id": "${PROJECT_ID}"}'
```

## Cleaning Up When Project Completes

When a project finishes, clean up its schedules:

```bash
# List project-related schedules
eve schedule list | jq '.schedules[] | select(.name | startswith("project-${PROJECT_ID}"))'

# Delete them
eve schedule delete --name "project-${PROJECT_ID}-daily-check"
```
```

---

## Timezone Handling

```
┌─────────────────────────────────────────────────────────────────┐
│                    TIMEZONE SUPPORT                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   All schedules support IANA timezone identifiers:             │
│                                                                 │
│   • "UTC" (default)                                            │
│   • "America/New_York"                                         │
│   • "America/Los_Angeles"                                      │
│   • "Europe/London"                                            │
│   • "Asia/Tokyo"                                               │
│                                                                 │
│   Example:                                                      │
│   ─────────                                                     │
│   cron: "0 9 * * *"                                            │
│   timezone: "America/New_York"                                 │
│                                                                 │
│   Runs at 9:00 AM Eastern Time:                                │
│   • Winter (EST): 14:00 UTC                                    │
│   • Summer (EDT): 13:00 UTC                                    │
│                                                                 │
│   DST transitions are handled automatically.                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Failure Handling

```sql
-- Automatically disable schedules after repeated failures
CREATE OR REPLACE FUNCTION eve.check_schedule_health()
RETURNS void AS $$
BEGIN
    -- Disable schedules with 5+ consecutive failures
    UPDATE eve.schedules s
    SET enabled = false,
        updated_at = now()
    WHERE enabled = true
      AND (
        SELECT COUNT(*)
        FROM eve.schedule_runs r
        WHERE r.schedule_id = s.id
          AND r.status = 'failed'
          AND r.started_at > (
            SELECT COALESCE(MAX(started_at), '1970-01-01')
            FROM eve.schedule_runs
            WHERE schedule_id = s.id AND status = 'success'
          )
      ) >= 5;

    -- TODO: Send notification about disabled schedules
END;
$$ LANGUAGE plpgsql;

-- Run health check every hour
SELECT cron.schedule(
    'eve-schedule-health-check',
    '0 * * * *',
    'SELECT eve.check_schedule_health()'
);
```

---

## Kubernetes CronJobs (v3 Alternative)

For v3 architecture, you can also use Kubernetes CronJobs:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daily-code-review
  namespace: eve-horizon
spec:
  schedule: "0 9 * * 1-5"
  timeZone: "America/New_York"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: trigger
            image: eve-horizon/cli:latest
            command:
            - eve
            - request
            - create
            - --worker-type=code-review
            - --prompt=Review all open PRs
            env:
            - name: EVE_ORG_ID
              value: "acme-corp"
            - name: EVE_USER_ID
              value: "service-account"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: eve-secrets
                  key: database-url
          restartPolicy: OnFailure
```

However, the **database-based approach is preferred** because:
1. Schedules are user-manageable via CLI
2. RLS enforces org isolation
3. Execution history is queryable
4. No Kubernetes access needed to manage schedules

---

## Implementation Phases

### Phase 1: Core Scheduling
- [ ] `eve.schedules` table with RLS
- [ ] `eve.schedule_runs` history table
- [ ] pg_cron scheduler function
- [ ] Basic CLI: create, list, delete

### Phase 2: Full CLI
- [ ] Human-readable schedule parsing
- [ ] Timezone support
- [ ] Update, enable/disable commands
- [ ] Trigger command for testing

### Phase 3: Monitoring
- [ ] Execution history queries
- [ ] Failure auto-disable
- [ ] Alerting on failures
- [ ] Dashboard integration

### Phase 4: Advanced
- [ ] Cron expression builder UI
- [ ] Schedule templates
- [ ] Dependencies between schedules
- [ ] Rate limiting per org

---

## References

- [Supabase pg_cron](https://supabase.com/docs/guides/database/extensions/pg_cron)
- [Supabase Cron Module](https://supabase.com/modules/cron)
- [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)
- [Cron Expression Syntax](https://crontab.guru/)

---

*Scheduling: The right work at the right time, automatically.*
