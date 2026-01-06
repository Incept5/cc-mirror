# eve-horizon v2: Minimal Core, Maximum Flexibility

> **Status**: Brainstorming v2
> **Insight**: The platform knows nothing about "projects" — it just runs workers with skills

## The Core Elegance

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   The platform is DUMB. Workers are SMART.                     │
│                                                                 │
│   Core platform provides:                                       │
│   • Queue (requests in, results out)                           │
│   • Worker routing (by type)                                   │
│   • Notifications (reply_to routing)                           │
│   • Multi-tenancy (org_id, user_id)                            │
│   • CLI tools for workers to interact with the queue           │
│                                                                 │
│   Everything else lives in SKILL.md files.                     │
│                                                                 │
│   A "project orchestrator" is just a worker with a skill       │
│   that knows how to manage long-running work.                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Event-Driven Orchestration (No Polling)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   ORCHESTRATORS DON'T POLL. THEY REACT.                        │
│                                                                 │
│   1. Orchestrator fires off tasks with reply_to: self          │
│   2. Orchestrator EXITS (frees resources)                      │
│   3. When ANY child completes → result triggers new request    │
│   4. Orchestrator wakes up, processes result, decides next     │
│   5. Repeat until done                                         │
│                                                                 │
│   No polling. No wasted cycles. Instant reaction.              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### The Wake-Up Mechanism

```
    Orchestrator runs
         │
         ├──► Creates Task A: reply_to: {type: 'orchestrator', request_id: 'orch-123'}
         ├──► Creates Task B: reply_to: {type: 'orchestrator', request_id: 'orch-123'}
         ├──► Creates Task C: reply_to: {type: 'orchestrator', request_id: 'orch-123'}
         │
         ▼
    Orchestrator EXITS (status: 'waiting')
         │
         │  [Workers process tasks in parallel]
         │
         ▼
    Task A completes
         │
         ▼
    Result inserted → Trigger fires
         │
         ▼
    New orchestration_request created:
      - worker_type: 'se-project-orchestrator'
      - context: {
          trigger: 'child_complete',
          completed_request_id: 'task-a-id',
          parent_request_id: 'orch-123'
        }
         │
         ▼
    Orchestrator wakes up, sees Task A done
         │
         ├──► Maybe creates Task D (depends on A)
         ├──► Updates project state
         │
         ▼
    Orchestrator EXITS again (waiting for B, C, D)
         │
         ▼
    [Cycle repeats until all work done]
```

### Database Implementation

```sql
-- reply_to types:
-- {type: 'slack', channel: '...', thread_ts: '...'}     → Post to Slack
-- {type: 'webhook', url: '...'}                         → POST to URL
-- {type: 'orchestrator', request_id: '...'}             → Wake up orchestrator

-- Trigger: When a result is inserted, check reply_to
CREATE OR REPLACE FUNCTION handle_result_reply()
RETURNS TRIGGER AS $$
DECLARE
    v_request eve.orchestration_requests;
    v_reply_type TEXT;
BEGIN
    IF NEW.reply_to IS NULL THEN
        RETURN NEW;
    END IF;

    v_reply_type := NEW.reply_to->>'type';

    CASE v_reply_type
        WHEN 'orchestrator' THEN
            -- Get the original orchestrator request to find worker_type and context
            SELECT * INTO v_request
            FROM eve.orchestration_requests
            WHERE id = (NEW.reply_to->>'request_id')::UUID;

            -- Create wake-up request for the orchestrator
            INSERT INTO eve.orchestration_requests (
                org_id, user_id, worker_type, prompt, context, status
            ) VALUES (
                NEW.org_id,
                v_request.user_id,
                v_request.worker_type,  -- Same orchestrator type
                'Child task completed - continue orchestration',
                jsonb_build_object(
                    'trigger', 'child_complete',
                    'completed_request_id', NEW.request_id,
                    'completed_result_id', NEW.id,
                    'parent_request_id', NEW.reply_to->>'request_id',
                    'parent_context', v_request.context  -- Carry forward context
                ),
                'pending'
            );

        WHEN 'slack' THEN
            PERFORM pgmq.send('slack_notify', row_to_json(NEW)::jsonb);

        WHEN 'webhook' THEN
            PERFORM pgmq.send('webhook_notify', row_to_json(NEW)::jsonb);
    END CASE;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER result_reply_trigger
    AFTER INSERT ON eve.orchestration_results
    FOR EACH ROW
    EXECUTE FUNCTION handle_result_reply();
```

### Orchestrator Request States

```sql
-- Extended status for orchestrators
-- 'pending'    → Waiting to be claimed
-- 'processing' → Currently running
-- 'waiting'    → Completed current run, waiting for children
-- 'completed'  → All done, project finished
-- 'failed'     → Unrecoverable error
```

### Task Dependencies (blocked_by)

Platform-level support for task graphs:

```sql
ALTER TABLE eve.orchestration_requests ADD COLUMN
    blocked_by UUID[] DEFAULT '{}';  -- Request IDs that must complete first

-- Index for efficient unblock checks
CREATE INDEX idx_requests_blocked ON eve.orchestration_requests USING GIN (blocked_by)
    WHERE status = 'blocked';

-- Status now includes 'blocked'
-- 'blocked' → Has unmet dependencies, not claimable yet
```

### Auto-Unblock Trigger

When a task completes, unblock anything waiting on it:

```sql
CREATE OR REPLACE FUNCTION check_unblocked_requests()
RETURNS TRIGGER AS $$
BEGIN
    -- Find all blocked requests that were waiting on this one
    -- and remove it from their blocked_by array
    UPDATE eve.orchestration_requests
    SET blocked_by = array_remove(blocked_by, NEW.request_id)
    WHERE NEW.request_id = ANY(blocked_by);

    -- Any requests with empty blocked_by array become pending
    UPDATE eve.orchestration_requests
    SET status = 'pending'
    WHERE status = 'blocked'
      AND blocked_by = '{}';

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER unblock_on_result
    AFTER INSERT ON eve.orchestration_results
    FOR EACH ROW
    WHEN (NEW.status = 'success')
    EXECUTE FUNCTION check_unblocked_requests();
```

### Combining Dependencies + Orchestrator Wake-up

The two mechanisms work together:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   blocked_by:  "Don't start this task until deps are done"     │
│   reply_to:    "When this task finishes, notify someone"       │
│                                                                 │
│   They compose naturally:                                       │
│                                                                 │
│   Task C:                                                       │
│     blocked_by: [Task A, Task B]   ← Won't start until A+B done │
│     reply_to: orchestrator         ← Wake up orch when C done   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Handling Multiple Completions

If Task A, B, C all complete within seconds, we don't want 3 wake-ups:

```sql
-- Option 1: Debounce in the trigger
-- Only create wake-up if orchestrator doesn't already have a pending request
CREATE OR REPLACE FUNCTION handle_result_reply()
RETURNS TRIGGER AS $$
BEGIN
    -- ... existing logic ...

    WHEN 'orchestrator' THEN
        -- Check if there's already a pending wake-up for this orchestrator
        IF NOT EXISTS (
            SELECT 1 FROM eve.orchestration_requests
            WHERE context->>'parent_request_id' = NEW.reply_to->>'request_id'
              AND status = 'pending'
        ) THEN
            -- Create wake-up request
            INSERT INTO eve.orchestration_requests (...);
        ELSE
            -- Just add to the list of completed tasks to process
            -- The pending wake-up will handle all completions
            UPDATE eve.orchestration_requests
            SET context = context || jsonb_build_object(
                'additional_completions',
                COALESCE(context->'additional_completions', '[]'::jsonb) ||
                jsonb_build_array(NEW.request_id)
            )
            WHERE context->>'parent_request_id' = NEW.reply_to->>'request_id'
              AND status = 'pending';
        END IF;

    -- ...
END;
$$ LANGUAGE plpgsql;
```

This ensures the orchestrator wakes up once and sees ALL completions, not repeatedly for each one.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         EVE-HORIZON                             │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    CORE SCHEMA (eve)                      │  │
│  │                                                           │  │
│  │  orchestration_requests    orchestration_results          │  │
│  │  worker_types              notifications (PGMQ)           │  │
│  │  organizations             org_members                    │  │
│  │  hitl_requests             slack_installations            │  │
│  │                                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                  │
│            ┌─────────────────┼─────────────────┐                │
│            │                 │                 │                │
│            ▼                 ▼                 ▼                │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐    │
│  │ general worker  │ │ playwright      │ │ se-project-     │    │
│  │                 │ │ worker          │ │ orchestrator    │    │
│  │ SKILL: default  │ │ SKILL: crawler  │ │ SKILL: se-orch  │    │
│  │ SCHEMA: none    │ │ SCHEMA: none    │ │ SCHEMA: se_proj │    │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘    │
│                                                 │                │
│                                                 ▼                │
│                              ┌───────────────────────────────┐  │
│                              │   SE_PROJECTS SCHEMA          │  │
│                              │                               │  │
│                              │   projects                    │  │
│                              │   project_tasks               │  │
│                              │   project_repos               │  │
│                              │                               │  │
│                              │   (managed by the skill,     │  │
│                              │    not by the platform)       │  │
│                              └───────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Platform (Minimal)

### Core Schema

```sql
-- SCHEMA: eve (or public)
-- This is ALL the platform knows about

-- Multi-tenancy
CREATE TABLE eve.organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT UNIQUE NOT NULL,
    settings        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE eve.org_members (
    org_id          UUID REFERENCES eve.organizations(id),
    user_id         UUID REFERENCES auth.users(id),
    role            TEXT DEFAULT 'member',
    PRIMARY KEY (org_id, user_id)
);

-- Worker types (just registry, no special logic)
CREATE TABLE eve.worker_types (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    docker_image    TEXT NOT NULL,
    capabilities    TEXT[] DEFAULT '{}',
    schema_name     TEXT,  -- Optional: schema this worker manages
    config          JSONB DEFAULT '{}'
);

-- The queue (that's it, no project_id, no special fields)
CREATE TABLE eve.orchestration_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),

    -- Tenant context
    org_id          UUID NOT NULL REFERENCES eve.organizations(id),
    user_id         UUID NOT NULL REFERENCES auth.users(id),

    -- Routing
    worker_type     TEXT NOT NULL REFERENCES eve.worker_types(id),

    -- The work
    status          TEXT DEFAULT 'pending',
    prompt          TEXT NOT NULL,

    -- Context (optional)
    repo_url        TEXT,
    branch          TEXT DEFAULT 'main',

    -- Reply routing
    reply_to        JSONB,  -- {type: 'slack'|'webhook'|'request', ...}

    -- Extensible context (skill-specific)
    context         JSONB DEFAULT '{}',  -- Skills store their context here

    -- Config
    config          JSONB DEFAULT '{}',
    metadata        JSONB DEFAULT '{}',

    -- Claim
    claimed_at      TIMESTAMPTZ,
    claimed_by      TEXT
);

-- Results
CREATE TABLE eve.orchestration_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL REFERENCES eve.orchestration_requests(id),
    org_id          UUID NOT NULL,

    status          TEXT NOT NULL,
    output          JSONB,
    summary         TEXT,

    -- Metrics
    duration_ms     INTEGER,
    tokens_used     INTEGER,

    -- Reply tracking
    reply_to        JSONB,
    reply_sent      BOOLEAN DEFAULT false,

    error           TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- HITL
CREATE TABLE eve.hitl_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL REFERENCES eve.orchestration_requests(id),
    org_id          UUID NOT NULL,

    question        TEXT NOT NULL,
    options         JSONB,
    reply_to        JSONB NOT NULL,

    status          TEXT DEFAULT 'pending',
    response        JSONB,

    expires_at      TIMESTAMPTZ DEFAULT (now() + interval '24 hours'),
    created_at      TIMESTAMPTZ DEFAULT now()
);
```

**Note what's NOT here:**
- No `projects` table
- No `project_id` column
- No task hierarchy
- No plan documents

The platform doesn't know about these. Skills do.

---

## CLI Tools for Skills

The platform exposes CLI tools that workers can use from within their SKILL.md:

```bash
# eve-cli: Platform interaction from within mclaude

# ============================================
# REQUEST MANAGEMENT
# ============================================

# Create a simple request
eve request create \
  --worker-type general \
  --prompt "Review this PR" \
  --repo-url "git@github.com:acme/app.git" \
  --context '{"project_id": "uuid-here"}'

# Create with orchestrator wake-up (shorthand for reply_to: orchestrator)
eve request create \
  --worker-type general \
  --prompt "Implement auth" \
  --reply-to-orchestrator

# Create with dependencies (won't start until blockers complete)
eve request create \
  --worker-type general \
  --prompt "Write integration tests" \
  --blocked-by "uuid-design-task,uuid-impl-task" \
  --reply-to-orchestrator

# Fan-out: Create multiple parallel tasks at once
eve request fan-out \
  --worker-type code-review \
  --prompts '["Review auth module", "Review API routes", "Review DB schema"]' \
  --repo-url "git@github.com:acme/app.git" \
  --reply-to-orchestrator
# Returns: {"request_ids": ["uuid1", "uuid2", "uuid3"]}

# Fan-in: Create a task that waits for multiple others
eve request create \
  --worker-type general \
  --prompt "Merge all reviewed changes" \
  --blocked-by "uuid1,uuid2,uuid3" \
  --reply-to-orchestrator

# Pipeline: Create a chain of dependent tasks
eve request pipeline \
  --tasks '[
    {"worker_type": "general", "prompt": "Design API"},
    {"worker_type": "general", "prompt": "Implement API"},
    {"worker_type": "code-review", "prompt": "Review implementation"},
    {"worker_type": "general", "prompt": "Write tests"}
  ]' \
  --repo-url "git@github.com:acme/app.git" \
  --reply-to-orchestrator
# Each task automatically blocked_by the previous one
# Returns: {"request_ids": ["uuid1", "uuid2", "uuid3", "uuid4"]}

# ============================================
# STATUS & RESULTS
# ============================================

# List requests with filters
eve request list \
  --context-filter '{"project_id": "uuid-here"}' \
  --status completed,failed

# Get request details
eve request get --id <uuid>
# Returns: {id, status, blocked_by, ...}

# Get result
eve result get --request-id <uuid>
# Returns: {status, output, summary, ...}

# Check what's blocking a request
eve request blockers --id <uuid>
# Returns: {blocked_by: [...], resolved: [...], pending: [...]}

# ============================================
# HITL (Human-in-the-Loop)
# ============================================

eve hitl ask \
  --question "Should I proceed with the refactor?" \
  --options '["Yes, proceed", "No, cancel", "Let me review first"]'
# Pauses orchestrator until human responds

# ============================================
# DATABASE (Custom Schemas)
# ============================================

eve db query --schema se_projects "SELECT * FROM projects WHERE id = $1" <uuid>
eve db execute --schema se_projects "UPDATE projects SET status = $1 WHERE id = $2" active <uuid>
```

### CLI Implementation

```typescript
// eve-cli is a lightweight Node.js CLI installed in worker containers
// It uses DATABASE_URL to connect to Supabase

// eve request create
async function createRequest(opts: CreateRequestOpts) {
  const { workerType, prompt, repoUrl, context, replyTo } = opts;

  // Inherit org_id/user_id from current request (via env vars)
  const orgId = process.env.EVE_ORG_ID;
  const userId = process.env.EVE_USER_ID;

  const result = await db.query(`
    INSERT INTO eve.orchestration_requests
    (org_id, user_id, worker_type, prompt, repo_url, context, reply_to)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [orgId, userId, workerType, prompt, repoUrl, context, replyTo]);

  console.log(JSON.stringify({ id: result.rows[0].id }));
}
```

---

## Example: SE Project Orchestrator

### Worker Type Registration

```sql
INSERT INTO eve.worker_types (id, name, docker_image, schema_name, capabilities) VALUES (
  'se-project-orchestrator',
  'Software Engineering Project Orchestrator',
  'eve-horizon/worker-se-orchestrator:latest',
  'se_projects',  -- This worker manages this schema
  '{"project-management", "multi-repo", "long-running"}'
);
```

### Custom Schema (Managed by Skill)

```sql
-- SCHEMA: se_projects
-- Created and managed by the se-project-orchestrator skill
-- Platform doesn't know about this

CREATE SCHEMA IF NOT EXISTS se_projects;

CREATE TABLE se_projects.projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL,
    created_by      UUID NOT NULL,

    name            TEXT NOT NULL,
    goal            TEXT NOT NULL,
    plan            TEXT,  -- Living plan document

    repositories    JSONB DEFAULT '[]',
    status          TEXT DEFAULT 'planning',
    phase           TEXT,

    -- Link to the orchestration request that's currently managing this project
    active_request_id UUID,

    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE se_projects.project_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES se_projects.projects(id),
    request_id      UUID,  -- Link to eve.orchestration_requests

    description     TEXT NOT NULL,
    status          TEXT DEFAULT 'pending',
    result_summary  TEXT,

    created_at      TIMESTAMPTZ DEFAULT now()
);
```

### The SKILL.md

```markdown
# SE Project Orchestrator

> **Load when**: Worker type is `se-project-orchestrator`

You are a software engineering project orchestrator. You manage long-running
projects that span multiple repositories and require coordination of many tasks.

## Event-Driven Model

You DON'T poll. You REACT.

- Fire off tasks with `--reply-to-orchestrator` flag
- Exit when done (status: 'waiting')
- Platform wakes you up when ANY child task completes
- Check what completed, decide next steps, fire more tasks
- Repeat until project is done

## Your Tools

You have access to the `eve` CLI for platform interaction:

### Creating Child Tasks (with wake-up)

```bash
# The --reply-to-orchestrator flag means:
# "When this task completes, wake me up"

eve request create \
  --worker-type code-review \
  --prompt "Review PR #123 for security issues" \
  --repo-url "git@github.com:acme/api.git" \
  --context '{"project_id": "$PROJECT_ID", "task_type": "review"}' \
  --reply-to-orchestrator  # <-- THIS IS KEY

eve request create \
  --worker-type general \
  --prompt "Implement user authentication endpoint" \
  --repo-url "git@github.com:acme/api.git" \
  --context '{"project_id": "$PROJECT_ID", "task_type": "implementation"}' \
  --reply-to-orchestrator
```

### Checking What Woke You Up

When you're triggered by a child completion, check the context:

```bash
# See what triggered this run
echo $EVE_TRIGGER              # 'initial' or 'child_complete'
echo $EVE_COMPLETED_REQUEST_ID # The child that just finished (if triggered)
echo $EVE_COMPLETED_RESULT_ID  # The result ID

# Get the completed result
eve result get --id $EVE_COMPLETED_RESULT_ID
```

### Checking All Task Status

```bash
# List all tasks for this project
eve request list --context-filter '{"project_id": "$PROJECT_ID"}'

# Get specific result
eve result get --request-id <task-request-id>
```

### Managing Project State

```bash
# Update project status
eve db execute --schema se_projects \
  "UPDATE projects SET status = $1, phase = $2, plan = $3 WHERE id = $4" \
  active "Phase 2: Implementation" "$UPDATED_PLAN" "$PROJECT_ID"

# Record task completion
eve db execute --schema se_projects \
  "UPDATE project_tasks SET status = $1, result_summary = $2 WHERE request_id = $3" \
  completed "PR merged successfully" "$TASK_REQUEST_ID"
```

### Asking Humans (Pauses Until Response)

```bash
eve hitl ask \
  --question "The tests are failing. Should I fix them or proceed anyway?" \
  --options '["Fix the tests first", "Proceed without tests", "Cancel the project"]'
# When human responds, you'll be woken up with EVE_TRIGGER='hitl_response'
```

## Your Workflow

### On First Run (trigger: 'initial')
1. Read the project goal from context
2. Create initial plan document
3. Break down into phases/tasks
4. Create child requests for first batch (WITH --reply-to-orchestrator)
5. Update project state
6. **EXIT** (you'll wake up when tasks complete)

### On Child Completion (trigger: 'child_complete')
1. Load project state from se_projects schema
2. Get the completed result: `eve result get --id $EVE_COMPLETED_RESULT_ID`
3. Update plan based on result
4. Check if this unblocks new work
5. If yes: create new tasks (WITH --reply-to-orchestrator)
6. If all tasks done: mark project complete, exit with 'completed'
7. Otherwise: **EXIT** (waiting for more completions)

### On HITL Response (trigger: 'hitl_response')
1. Get human's answer from context
2. Proceed based on their decision
3. Create new tasks if needed
4. **EXIT**

## Context Variables

Injected as environment variables:
- `EVE_ORG_ID` - Current organization
- `EVE_USER_ID` - User who initiated
- `EVE_REQUEST_ID` - This request's ID
- `EVE_TRIGGER` - What triggered this run: 'initial', 'child_complete', 'hitl_response'
- `EVE_COMPLETED_REQUEST_ID` - If trigger=child_complete, which request finished
- `EVE_COMPLETED_RESULT_ID` - If trigger=child_complete, the result ID
- `PROJECT_ID` - From context.project_id

## Output Format

Always output structured JSON at the end:

```json
{
  "orchestrator_status": "waiting",  // 'waiting', 'completed', 'failed'
  "summary": "Task A completed. Created tasks D, E. Waiting for B, C, D, E.",
  "tasks_created": ["uuid-d", "uuid-e"],
  "tasks_pending": ["uuid-b", "uuid-c", "uuid-d", "uuid-e"],
  "plan_updated": true
}
```

## Orchestration Patterns

### Pattern 1: Fan-Out (Parallel Execution)

```bash
# Launch 3 parallel reviews, wake up when ANY completes
eve request fan-out \
  --worker-type code-review \
  --prompts '["Review auth", "Review API", "Review DB"]' \
  --reply-to-orchestrator

# Output: {"request_ids": ["r1", "r2", "r3"]}
# You'll be woken up 3 times (once per completion)
```

### Pattern 2: Fan-In (Wait for All)

```bash
# Create a "collector" task blocked by all parallel tasks
REVIEWS=$(eve request fan-out --worker-type code-review --prompts '[...]' --reply-to-orchestrator)
REVIEW_IDS=$(echo $REVIEWS | jq -r '.request_ids | join(",")')

eve request create \
  --worker-type general \
  --prompt "Merge all reviewed PRs" \
  --blocked-by "$REVIEW_IDS" \
  --reply-to-orchestrator

# The merge task only starts after ALL reviews complete
# You're woken up once when the merge task finishes
```

### Pattern 3: Pipeline (Sequential)

```bash
# Chain of dependent tasks - each waits for the previous
eve request pipeline \
  --tasks '[
    {"worker_type": "general", "prompt": "Design the feature"},
    {"worker_type": "general", "prompt": "Implement the design"},
    {"worker_type": "code-review", "prompt": "Review implementation"},
    {"worker_type": "general", "prompt": "Address review feedback"},
    {"worker_type": "general", "prompt": "Write documentation"}
  ]' \
  --reply-to-orchestrator

# Tasks execute: Design → Implement → Review → Feedback → Docs
# You're woken up 5 times (once per stage completion)
```

### Pattern 4: Diamond (Parallel then Merge)

```bash
# Common pattern: one task fans out, results merge back
#
#        ┌─► Task B ─┐
# Task A ─┤          ├─► Task D
#        └─► Task C ─┘

# Create Task A
A=$(eve request create --worker-type general --prompt "Design" | jq -r '.id')

# Fan out B and C, both blocked by A
B=$(eve request create --worker-type general --prompt "Impl Module 1" --blocked-by "$A" | jq -r '.id')
C=$(eve request create --worker-type general --prompt "Impl Module 2" --blocked-by "$A" | jq -r '.id')

# D waits for both B and C
eve request create \
  --worker-type general \
  --prompt "Integrate modules" \
  --blocked-by "$B,$C" \
  --reply-to-orchestrator
```

### Pattern 5: Speculative (Race)

```bash
# Try multiple approaches, use first success
ATTEMPTS=$(eve request fan-out \
  --worker-type general \
  --prompts '["Try approach A", "Try approach B", "Try approach C"]' \
  --reply-to-orchestrator)

# When first one completes, cancel the others
# (On wake-up, check which succeeded, cancel rest)
for id in $(eve request list --context-filter '{"race_group": "xyz"}' --status pending | jq -r '.[].id'); do
  eve request cancel --id "$id"
done
```

## Example Flow

```
Run 1 (trigger: initial)
├── Create plan
├── Fan-out: Create parallel tasks A, B, C with --reply-to-orchestrator
├── Update project state
└── EXIT (waiting)

[Task A completes first]

Run 2 (trigger: child_complete, completed: Task A)
├── Read Task A result
├── A was independent, no new tasks unlocked yet
├── Update plan with A's results
└── EXIT (still waiting for B, C)

[Task B completes]

Run 3 (trigger: child_complete, completed: Task B)
├── Read Task B result
├── B + A together unlock Task D (was blocked_by A, B)
├── Note: D auto-started because platform unblocked it!
└── EXIT (waiting for C, D)

[Task C completes]

Run 4 (trigger: child_complete, completed: Task C)
├── Read Task C result
├── Create Task E (depends on C's output)
├── Create Task F (depends on C's output)
└── EXIT (waiting for D, E, F)

[Task D completes - this was the merge task]

Run 5 (trigger: child_complete, completed: Task D)
├── D was the integration task
├── Create final Task G: "Deploy" blocked by E, F
└── EXIT (waiting for E, F, G)

... eventually all tasks done, project complete
```
```

### Dockerfile

```dockerfile
FROM eve-horizon/worker-base:latest

# Install the SE orchestrator skill
RUN rm -f /root/.cc-mirror/mc/config/skills/orchestration/.cc-mirror-managed

COPY skills/se-project-orchestrator/SKILL.md \
  /root/.cc-mirror/mc/config/skills/orchestration/references/domains/se-project-orchestrator.md

# Schema migration handled by eve-cli on first run (or externally)

ENV WORKER_TYPE=se-project-orchestrator
# NOTE: No special poll interval needed!
# Orchestrators are event-driven, not polling-based.
# They wake up when children complete, not on a timer.
```

---

## Creating a New Orchestrator Type

Want to create a "Data Analysis Project Orchestrator"? Same pattern:

1. **Register worker type**
   ```sql
   INSERT INTO eve.worker_types (id, name, docker_image, schema_name) VALUES (
     'data-project-orchestrator',
     'Data Analysis Project Orchestrator',
     'eve-horizon/worker-data-orchestrator:latest',
     'data_projects'
   );
   ```

2. **Create custom schema**
   ```sql
   CREATE SCHEMA data_projects;
   CREATE TABLE data_projects.analyses (...);
   CREATE TABLE data_projects.datasets (...);
   ```

3. **Write SKILL.md**
   - Define the workflow for data projects
   - Use `eve` CLI to create tasks (data processing, visualization, etc.)
   - Manage state in `data_projects` schema

4. **Build Docker image**
   - Base image + skill files + schema init

**The platform doesn't change. Only skills do.**

---

## Control Plane (Minimal)

The NestJS control plane is thin:

```typescript
// POST /requests - Create a request
async createRequest(dto: CreateRequestDto, user: AuthUser) {
  // Validate org membership
  await this.validateOrgAccess(dto.orgId, user.id);

  // Insert into queue
  return this.db.query(`
    INSERT INTO eve.orchestration_requests
    (org_id, user_id, worker_type, prompt, repo_url, context, reply_to, config, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [dto.orgId, user.id, dto.workerType, dto.prompt, dto.repoUrl,
      dto.context, dto.replyTo, dto.config, dto.metadata]);
}

// GET /requests/:id - Get request status
// GET /results/:requestId - Get result
// POST /hitl/:id/respond - Respond to HITL question

// That's basically it. The control plane is just a REST wrapper around the queue.
```

### Slack Integration

```typescript
// /eve review https://github.com/acme/app/pull/123
async handleEveCommand(text: string, context: SlackContext) {
  // Parse intent (could use Claude Agent SDK for smart parsing)
  const intent = this.parseIntent(text);

  // Create request with appropriate worker type
  await this.db.query(`
    INSERT INTO eve.orchestration_requests
    (org_id, user_id, worker_type, prompt, reply_to, context)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    context.orgId,
    context.userId,
    intent.workerType,  // 'code-review', 'general', 'se-project-orchestrator'
    intent.prompt,
    { type: 'slack', channel: context.channel, thread_ts: context.threadTs },
    intent.context
  ]);

  return 'On it!';
}
```

---

## Flow: Creating a Project via Slack

```
User: "/eve project Create a user authentication system for our app"
                │
                ▼
Control Plane:
  - Parse intent: project creation
  - Worker type: se-project-orchestrator
  - Create request with context: {goal: "Create auth system"}
                │
                ▼
SE Project Orchestrator Worker claims request:
  - Creates se_projects.projects record
  - Generates initial plan
  - Creates child tasks:
    - general worker: "Design auth schema"
    - general worker: "Implement JWT generation"
    - code-review worker: "Review security approach"
  - Schedules next check-in (30 min)
  - Returns result
                │
                ▼
Notification → Slack:
  "Started project 'User Authentication'. Plan created with 3 initial tasks."
                │
                ▼
[30 minutes later]
                │
                ▼
SE Project Orchestrator re-runs:
  - Checks child task status
  - "Design" task complete, "JWT" in progress
  - Updates plan with design decisions
  - Creates new tasks based on design
  - Schedules next check-in
                │
                ▼
[Repeat until complete]
```

---

## Why This Is More Elegant

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  1. PLATFORM IS DUMB, SKILLS ARE SMART                         │
│     The core platform has no concept of "projects".            │
│     It's just a queue with routing and reply triggers.         │
│                                                                 │
│  2. EVENT-DRIVEN, NOT POLLING                                   │
│     Orchestrators fire tasks, EXIT, get woken up.              │
│     No wasted cycles. Instant reaction. Scales infinitely.     │
│                                                                 │
│  3. NEW ORCHESTRATORS = NEW SKILLS, NOT NEW CODE               │
│     Want a "research orchestrator"? Write a SKILL.md.          │
│     No platform changes required.                              │
│                                                                 │
│  4. SCHEMA ISOLATION IS NATURAL                                 │
│     Each orchestrator type manages its own schema.             │
│     Platform provides the CLI, skill defines the structure.    │
│                                                                 │
│  5. UNIFORM INTERFACE                                           │
│     Every worker uses the same eve CLI.                        │
│     Simple tasks and complex orchestrators share the pattern.  │
│                                                                 │
│  6. COMPOSABLE                                                  │
│     Orchestrators can spawn other orchestrators.               │
│     A "mega-project" could coordinate multiple "sub-projects". │
│                                                                 │
│  7. TESTABLE                                                    │
│     Skills are just markdown + CLI calls.                      │
│     Test them by mocking the eve CLI responses.                │
│                                                                 │
│  8. PORTABLE                                                    │
│     Skills don't depend on platform internals.                 │
│     Could run on different queue backends with same skills.    │
│                                                                 │
│  9. RESOURCE EFFICIENT                                          │
│     Long-running projects don't consume resources while idle.  │
│     Only pay for compute when actually doing work.             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Orchestration Primitives Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                   PLATFORM PRIMITIVES                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  blocked_by: UUID[]                                             │
│    • Task won't start until ALL blockers complete               │
│    • Platform auto-unblocks when deps resolve                   │
│    • Enables: fan-in, pipelines, diamonds                       │
│                                                                 │
│  reply_to: {type: 'orchestrator', request_id: ...}              │
│    • Wake up orchestrator when task completes                   │
│    • Enables: event-driven coordination                         │
│                                                                 │
│  status: blocked → pending → claimed → processing → completed   │
│    • Platform manages lifecycle                                 │
│    • Workers just claim 'pending' tasks                         │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                   CLI CONVENIENCES                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  eve request create --blocked-by X,Y,Z                          │
│    • Single task with dependencies                              │
│                                                                 │
│  eve request fan-out --prompts [...]                            │
│    • Multiple parallel tasks, same config                       │
│                                                                 │
│  eve request pipeline --tasks [...]                             │
│    • Chain of sequential tasks                                  │
│                                                                 │
│  eve request cancel --id X                                      │
│    • Cancel pending/blocked task (for speculative)              │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                   PATTERNS (in SKILL.md)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Fan-out:     N parallel tasks, wake on each completion         │
│  Fan-in:      Create collector blocked by N tasks               │
│  Pipeline:    Chain with automatic blocked_by                   │
│  Diamond:     Parallel branches merging back                    │
│  Speculative: Race tasks, cancel losers                         │
│  Map-reduce:  Fan-out → process → fan-in reducer                │
│                                                                 │
│  Skills compose these primitives for their workflows.           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core vs Skills

| Core Platform Provides | Skills Define |
|------------------------|---------------|
| Queue (requests/results) | Workflow logic |
| Worker routing | Domain knowledge |
| Multi-tenancy | Custom schemas |
| Notifications | State management |
| HITL infrastructure | Decision points |
| `eve` CLI | What to do with it |

---

## MVP Phases (Simplified)

### Phase 1: Core
- [ ] Core schema (requests, results, worker_types, orgs)
- [ ] `eve` CLI (request, result, hitl, db commands)
- [ ] Base worker image with CLI installed
- [ ] General-purpose worker
- [ ] Simple control plane API

### Phase 2: Notifications
- [ ] PGMQ setup
- [ ] Slack integration
- [ ] Reply routing

### Phase 3: HITL
- [ ] hitl_requests table
- [ ] `eve hitl ask` command
- [ ] Slack button handler

### Phase 4: First Orchestrator
- [ ] SE Project Orchestrator skill
- [ ] se_projects schema
- [ ] End-to-end project flow

### Phase 5: More Workers
- [ ] Playwright worker
- [ ] Code-review worker
- [ ] Data worker

---

## Open Questions

1. **Schema migrations**: How do skills manage their schema migrations? Flyway? Embedded in Docker?
2. **CLI authentication**: How does `eve` CLI authenticate? Service account? Inherit from mclaude env?
3. **Request delays**: How to implement `delay_minutes` for scheduled check-ins? pg_cron? PGMQ delay?
4. **Result aggregation**: How do orchestrators efficiently get all child results?
5. **Cost attribution**: Should `eve request create` track parent-child for cost rollup?

---

## The Mantra

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   "If you need new platform features, you're doing it wrong."  │
│                                                                 │
│   Everything should be expressible as:                         │
│   • A worker type (Docker image)                               │
│   • A skill (SKILL.md)                                         │
│   • A schema (for state)                                       │
│   • CLI calls (for interaction)                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

*v2 - Minimal core, maximum flexibility*
