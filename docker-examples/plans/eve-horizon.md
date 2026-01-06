# eve-horizon: AI Agent Platform Architecture

> **Status**: Brainstorming
> **Goal**: Elegant, simple platform for multi-tenant AI agent orchestration

## The Core Insight

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   The worker pattern is RECURSIVE.                             │
│                                                                 │
│   A "project orchestrator" is just another worker that:        │
│   • Runs longer (hours/days vs minutes)                        │
│   • Creates tasks instead of executing them                    │
│   • Manages a plan document that evolves                       │
│                                                                 │
│   Same queue. Same pattern. Different time horizon.            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture Overview

```
                                    ┌─────────────────────────────────┐
                                    │         Supabase                │
                                    │  ┌───────────────────────────┐  │
                                    │  │   Auth (GoTrue)           │  │
                                    │  │   • Users, sessions       │  │
                                    │  │   • JWT tokens            │  │
                                    │  └───────────────────────────┘  │
                                    │  ┌───────────────────────────┐  │
                                    │  │   Kong (API Gateway)      │  │
                                    │  │   • Rate limiting         │  │
                                    │  │   • API key validation    │  │
                                    │  └───────────────────────────┘  │
                                    │  ┌───────────────────────────┐  │
                                    │  │   PostgreSQL              │  │
                                    │  │   • Multi-tenant schemas  │  │
                                    │  │   • RLS policies          │  │
                                    │  └───────────────────────────┘  │
                                    │  ┌───────────────────────────┐  │
                                    │  │   Realtime (optional)     │  │
                                    │  │   • Live status updates   │  │
                                    │  └───────────────────────────┘  │
                                    └─────────────────────────────────┘
                                                    │
                        ┌───────────────────────────┼───────────────────────────┐
                        │                           │                           │
                        ▼                           ▼                           ▼
           ┌────────────────────┐      ┌────────────────────┐      ┌────────────────────┐
           │   Control Plane    │      │  Project Workers   │      │   Task Workers     │
           │   (NestJS)         │      │  (Long-running)    │      │   (Short-lived)    │
           │                    │      │                    │      │                    │
           │ • HTTP/REST API    │      │ • Poll: 5-15 min   │      │ • Poll: 5 sec      │
           │ • Claude Agent SDK │      │ • Manage projects  │      │ • Execute tasks    │
           │ • Auth middleware  │      │ • Create tasks     │      │ • Report results   │
           │ • Request routing  │      │ • Update plans     │      │ • Git operations   │
           └────────────────────┘      └────────────────────┘      └────────────────────┘
                    │                           │                           │
                    └───────────────────────────┴───────────────────────────┘
                                                │
                                                ▼
                                    ┌─────────────────────────┐
                                    │   orchestration_requests │
                                    │   (unified queue)        │
                                    └─────────────────────────┘
```

---

## Multi-Tenancy Model

### Users & Organizations

```sql
-- Supabase auth handles users, we extend with:

CREATE TABLE organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),
    name            TEXT NOT NULL,
    slug            TEXT UNIQUE NOT NULL,  -- eve-horizon.io/acme-corp
    settings        JSONB DEFAULT '{}'
);

CREATE TABLE org_members (
    org_id          UUID REFERENCES organizations(id),
    user_id         UUID REFERENCES auth.users(id),
    role            TEXT NOT NULL DEFAULT 'member',  -- owner, admin, member
    created_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);

-- A user can be in multiple orgs
-- Each request carries (user_id, org_id) context
```

### Row-Level Security

```sql
-- Every tenant-scoped table includes:
-- • org_id UUID REFERENCES organizations(id)
-- • created_by UUID REFERENCES auth.users(id)

-- RLS policy pattern:
CREATE POLICY "org_isolation" ON some_table
    USING (org_id IN (
        SELECT org_id FROM org_members
        WHERE user_id = auth.uid()
    ));
```

---

## Worker Types (First-Class)

Workers are specialized containers with different capabilities:

```sql
CREATE TABLE worker_types (
    id              TEXT PRIMARY KEY,           -- 'general', 'playwright', 'code-review'
    name            TEXT NOT NULL,
    description     TEXT,
    docker_image    TEXT NOT NULL,              -- 'eve-horizon/worker-playwright:latest'
    capabilities    TEXT[] DEFAULT '{}',        -- ['browser', 'screenshot', 'pdf']
    config          JSONB DEFAULT '{}',         -- default timeout, model, etc.
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Seed examples
INSERT INTO worker_types (id, name, docker_image, capabilities) VALUES
    ('general',     'General Purpose',   'eve-horizon/worker-general:latest',    '{"git", "code"}'),
    ('playwright',  'Web Crawler',       'eve-horizon/worker-playwright:latest', '{"browser", "screenshot", "pdf"}'),
    ('code-review', 'Code Reviewer',     'eve-horizon/worker-code-review:latest','{"git", "github-api"}'),
    ('data',        'Data Analysis',     'eve-horizon/worker-data:latest',       '{"python", "pandas", "jupyter"}'),
    ('supabase',    'Supabase Admin',    'eve-horizon/worker-supabase:latest',   '{"supabase-cli", "postgres"}');
```

---

## Request Model (Extended)

```sql
CREATE TABLE orchestration_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),

    -- Tenant context (ALWAYS present)
    org_id          UUID NOT NULL REFERENCES organizations(id),
    user_id         UUID NOT NULL REFERENCES auth.users(id),

    -- Worker routing (CRITICAL)
    worker_type     TEXT NOT NULL DEFAULT 'general' REFERENCES worker_types(id),

    -- Standard fields
    status          TEXT DEFAULT 'pending',  -- pending, claimed, processing, completed, failed, waiting_input
    repo_url        TEXT,
    branch          TEXT DEFAULT 'main',
    prompt          TEXT NOT NULL,

    -- Extended context
    project_id      UUID REFERENCES projects(id),
    parent_id       UUID REFERENCES orchestration_requests(id),

    -- Reply routing (for HITL)
    reply_to        JSONB,  -- {type: 'slack', channel: 'C123', thread_ts: '...'}
                            -- {type: 'webhook', url: '...'}
                            -- {type: 'user', user_id: '...'}

    -- Config & metadata
    config          JSONB DEFAULT '{}',
    metadata        JSONB DEFAULT '{}',

    -- Claim tracking
    claimed_at      TIMESTAMPTZ,
    claimed_by      TEXT
);

-- Workers poll for their type
CREATE INDEX idx_requests_worker_status
    ON orchestration_requests(worker_type, status, created_at);
```

---

## Results Table (with Reply Routing)

```sql
CREATE TABLE orchestration_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),

    -- Link to request
    request_id      UUID NOT NULL REFERENCES orchestration_requests(id),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    project_id      UUID REFERENCES projects(id),

    -- Execution outcome
    status          TEXT NOT NULL,  -- success, error, partial, timeout, needs_input
    output          JSONB,          -- Full structured output from mclaude
    summary         TEXT,           -- Human-readable summary

    -- Git context (if applicable)
    pr_url          TEXT,
    commit_sha      TEXT,
    branch          TEXT,

    -- Metrics
    duration_ms     INTEGER,
    tokens_used     INTEGER,
    cost_usd        NUMERIC(10,6),

    -- Error details
    error           TEXT,
    error_code      TEXT,

    -- Reply routing (copied from request for convenience)
    reply_to        JSONB,
    reply_sent      BOOLEAN DEFAULT false,
    reply_sent_at   TIMESTAMPTZ
);

CREATE INDEX idx_results_request ON orchestration_results(request_id);
CREATE INDEX idx_results_pending_reply ON orchestration_results(reply_sent, created_at)
    WHERE reply_sent = false AND reply_to IS NOT NULL;
```

---

## HITL: Human-in-the-Loop Support

When workers need human input (clarification, approval, credentials):

```sql
CREATE TABLE hitl_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),

    -- Context
    request_id      UUID NOT NULL REFERENCES orchestration_requests(id),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    user_id         UUID REFERENCES auth.users(id),  -- Who should respond

    -- Question
    question_type   TEXT NOT NULL,  -- 'clarification', 'approval', 'choice', 'credentials'
    question        TEXT NOT NULL,
    options         JSONB,          -- For multiple choice: [{label, value}]
    context         JSONB,          -- Additional context for the human

    -- Reply routing
    reply_to        JSONB NOT NULL,  -- Where to send the question

    -- Response
    status          TEXT DEFAULT 'pending',  -- pending, answered, expired, cancelled
    response        JSONB,
    responded_at    TIMESTAMPTZ,
    responded_by    UUID REFERENCES auth.users(id),

    -- Timeout
    expires_at      TIMESTAMPTZ DEFAULT (now() + interval '24 hours')
);

CREATE INDEX idx_hitl_pending ON hitl_requests(status, expires_at)
    WHERE status = 'pending';
```

### HITL Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         HITL FLOW                               │
└─────────────────────────────────────────────────────────────────┘

    Worker encounters decision point
                │
                ▼
    Worker creates hitl_request with question
    Sets orchestration_request.status = 'waiting_input'
                │
                ▼
    Notification sent via reply_to channel (Slack, etc.)
                │
                ▼
    Human responds (via Slack, UI, API)
                │
                ▼
    hitl_request.response updated
    orchestration_request.status = 'pending' (re-queued)
                │
                ▼
    Worker re-claims, continues with human's answer
```

---

## Projects: Long-Running Orchestration

```sql
CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),

    -- Tenant context
    org_id          UUID NOT NULL REFERENCES organizations(id),
    created_by      UUID NOT NULL REFERENCES auth.users(id),

    -- Project identity
    name            TEXT NOT NULL,
    goal            TEXT NOT NULL,  -- High-level objective

    -- Living plan (markdown, editable by project worker)
    plan            TEXT,

    -- Multi-repo support
    repositories    JSONB DEFAULT '[]',  -- [{url, branch, role}]

    -- State
    status          TEXT DEFAULT 'planning',  -- planning, active, paused, completed
    phase           TEXT,

    -- Metrics
    tasks_total     INTEGER DEFAULT 0,
    tasks_completed INTEGER DEFAULT 0,

    config          JSONB DEFAULT '{}'
);
```

### Project Worker Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                      PROJECT WORKER LOOP                        │
└─────────────────────────────────────────────────────────────────┘

    Claim project request (type='project')
                │
                ▼
    Load context: project record, plan, recent results
                │
                ▼
    Run mclaude with project orchestrator prompt:
    "You manage this project. Current plan: [...]
     Recent results: [...]. What's next?"
                │
                ▼
    Agent outputs structured response:
    • plan_updates (revised plan)
    • new_tasks [{prompt, repo_url}]
    • status_change (if complete)
                │
                ▼
    Worker applies changes:
    • Update project.plan
    • Insert new orchestration_requests (type='task')
    • Update project.status
                │
                ▼
    If not complete: schedule next check
    (create new project request with delay)
```

---

## Worker Pools

Workers claim by `worker_type`, not request_type:

```
┌─────────────────────────────────────────────────────────────────┐
│  GENERAL WORKERS                                                │
│  • Claim: WHERE worker_type = 'general'                         │
│  • Poll: 5 seconds                                              │
│  • Capabilities: git, code editing, file operations             │
│  • Replicas: 3-10+ (scale with load)                            │
├─────────────────────────────────────────────────────────────────┤
│  PLAYWRIGHT WORKERS                                             │
│  • Claim: WHERE worker_type = 'playwright'                      │
│  • Poll: 5 seconds                                              │
│  • Capabilities: browser automation, screenshots, PDF gen       │
│  • Replicas: 1-3                                                │
├─────────────────────────────────────────────────────────────────┤
│  CODE-REVIEW WORKERS                                            │
│  • Claim: WHERE worker_type = 'code-review'                     │
│  • Poll: 5 seconds                                              │
│  • Capabilities: git, GitHub API, PR comments                   │
│  • Replicas: 2-5                                                │
├─────────────────────────────────────────────────────────────────┤
│  DATA WORKERS                                                   │
│  • Claim: WHERE worker_type = 'data'                            │
│  • Poll: 5 seconds                                              │
│  • Capabilities: Python, pandas, jupyter, visualizations        │
│  • Replicas: 1-3                                                │
├─────────────────────────────────────────────────────────────────┤
│  PROJECT ORCHESTRATORS (special case)                           │
│  • Claim: WHERE worker_type = 'general' AND project_id IS NOT NULL │
│  • Poll: 5-15 minutes (configurable per project)                │
│  • Role: Manages project plan, creates child tasks              │
│  • Replicas: 1-2                                                │
└─────────────────────────────────────────────────────────────────┘
```

### Worker Claim Query

```sql
-- Each worker type has its own claim function
CREATE OR REPLACE FUNCTION claim_request(p_worker_type TEXT, p_worker_id TEXT)
RETURNS orchestration_requests AS $$
DECLARE
    v_request orchestration_requests;
BEGIN
    SELECT * INTO v_request
    FROM orchestration_requests
    WHERE worker_type = p_worker_type
      AND status = 'pending'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF v_request IS NOT NULL THEN
        UPDATE orchestration_requests
        SET status = 'claimed',
            claimed_at = now(),
            claimed_by = p_worker_id
        WHERE id = v_request.id;
    END IF;

    RETURN v_request;
END;
$$ LANGUAGE plpgsql;
```

---

## Control Plane (NestJS)

```typescript
// POST /projects
async createProject(dto: CreateProjectDto, user: AuthUser) {
  // 1. Validate org membership
  await this.validateOrgAccess(dto.orgId, user.id);

  // 2. Create project record
  const project = await this.db.projects.create({
    org_id: dto.orgId,
    created_by: user.id,
    name: dto.name,
    goal: dto.goal,
    repositories: dto.repositories,
  });

  // 3. Create initial project request
  await this.db.orchestration_requests.create({
    org_id: dto.orgId,
    user_id: user.id,
    request_type: 'project',
    project_id: project.id,
    prompt: `Initialize project: ${dto.goal}`,
  });

  return project;
}
```

---

## Metadata Injection

Workers inject tenant context as environment variables:

```typescript
function buildMetadataEnv(request: Request): Record<string, string> {
  return {
    EVE_USER_ID: request.user_id,
    EVE_ORG_ID: request.org_id,
    EVE_PROJECT_ID: request.project_id ?? '',
    // Plus any custom metadata from request.metadata
    ...convertToEnvVars(request.metadata),
  };
}
```

---

## Notifications (PGMQ)

Supabase has native [PGMQ support](https://supabase.com/docs/guides/queues/pgmq) for durable message queues.

### Queue Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    NOTIFICATION QUEUES                          │
└─────────────────────────────────────────────────────────────────┘

    orchestration_results INSERT
                │
                ▼
    Postgres TRIGGER
                │
    ┌───────────┴───────────┐
    │                       │
    ▼                       ▼
┌─────────┐           ┌─────────┐
│ slack   │           │ webhook │
│ _notify │           │ _notify │
└────┬────┘           └────┬────┘
     │                     │
     ▼                     ▼
┌─────────┐           ┌─────────┐
│ Slack   │           │ Webhook │
│ Worker  │           │ Worker  │
└─────────┘           └─────────┘
```

### Setup

```sql
-- Enable PGMQ extension
CREATE EXTENSION IF NOT EXISTS pgmq;

-- Create notification queues
SELECT pgmq.create('slack_notify');
SELECT pgmq.create('webhook_notify');
SELECT pgmq.create('hitl_questions');

-- Trigger to route results to appropriate queue
CREATE OR REPLACE FUNCTION route_result_notification()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.reply_to IS NOT NULL AND NEW.reply_sent = false THEN
        CASE NEW.reply_to->>'type'
            WHEN 'slack' THEN
                PERFORM pgmq.send('slack_notify', jsonb_build_object(
                    'result_id', NEW.id,
                    'request_id', NEW.request_id,
                    'channel', NEW.reply_to->>'channel',
                    'thread_ts', NEW.reply_to->>'thread_ts',
                    'summary', NEW.summary,
                    'status', NEW.status
                ));
            WHEN 'webhook' THEN
                PERFORM pgmq.send('webhook_notify', jsonb_build_object(
                    'result_id', NEW.id,
                    'url', NEW.reply_to->>'url',
                    'payload', row_to_json(NEW)
                ));
        END CASE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER result_notification_trigger
    AFTER INSERT ON orchestration_results
    FOR EACH ROW
    EXECUTE FUNCTION route_result_notification();
```

### Consuming Notifications (NestJS)

```typescript
// slack-notifier.service.ts
@Injectable()
export class SlackNotifierService {
  private readonly QUEUE = 'slack_notify';

  @Cron('*/5 * * * * *')  // Every 5 seconds
  async processQueue() {
    const messages = await this.db.query(
      `SELECT * FROM pgmq.read('${this.QUEUE}', 30, 10)`  // 30s visibility, batch of 10
    );

    for (const msg of messages) {
      try {
        await this.slack.chat.postMessage({
          channel: msg.message.channel,
          thread_ts: msg.message.thread_ts,
          text: this.formatResult(msg.message),
        });

        // Mark result as sent
        await this.db.query(
          `UPDATE orchestration_results SET reply_sent = true, reply_sent_at = now() WHERE id = $1`,
          [msg.message.result_id]
        );

        // Delete from queue
        await this.db.query(`SELECT pgmq.delete('${this.QUEUE}', $1)`, [msg.msg_id]);
      } catch (error) {
        // Message returns to queue after visibility timeout
        this.logger.error('Slack notification failed', error);
      }
    }
  }
}
```

---

## Slack Integration (First-Class)

Slack is a primary interface, not an afterthought.

### Bot Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      SLACK BOT FLOW                             │
└─────────────────────────────────────────────────────────────────┘

    User: "@eve review this PR: github.com/..."
                │
                ▼
    Slack Event API → Control Plane
                │
                ▼
    Parse intent, extract context
    (PR URL, channel, thread, user)
                │
                ▼
    Create orchestration_request:
    - worker_type: 'code-review'
    - reply_to: {type: 'slack', channel, thread_ts}
    - metadata: {slack_user_id, pr_url}
                │
                ▼
    Immediate ack: "On it! Reviewing now..."
                │
                ▼
    [Worker processes async]
                │
                ▼
    Result → PGMQ → Slack reply in thread
```

### Slack-Specific Tables

```sql
-- Map Slack workspaces to orgs
CREATE TABLE slack_installations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    team_id         TEXT UNIQUE NOT NULL,  -- Slack workspace ID
    team_name       TEXT,
    bot_token       TEXT NOT NULL,         -- Encrypted
    bot_user_id     TEXT,
    installed_by    UUID REFERENCES auth.users(id),
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Map Slack users to platform users
CREATE TABLE slack_user_mappings (
    slack_user_id   TEXT NOT NULL,
    slack_team_id   TEXT NOT NULL,
    user_id         UUID REFERENCES auth.users(id),
    org_id          UUID REFERENCES organizations(id),
    PRIMARY KEY (slack_user_id, slack_team_id)
);

-- Channel → Project mappings (optional)
CREATE TABLE slack_channel_projects (
    channel_id      TEXT NOT NULL,
    team_id         TEXT NOT NULL,
    project_id      UUID REFERENCES projects(id),
    PRIMARY KEY (channel_id, team_id)
);
```

### Slash Commands

```typescript
// POST /slack/commands
async handleSlashCommand(body: SlackCommandPayload) {
  const { command, text, channel_id, thread_ts, user_id, team_id } = body;

  // Map Slack user to platform user
  const mapping = await this.getSlackUserMapping(user_id, team_id);

  switch (command) {
    case '/eve':
      return this.handleEveCommand(text, {
        channel: channel_id,
        thread_ts,
        user: mapping,
      });

    case '/eve-project':
      return this.handleProjectCommand(text, mapping);

    case '/eve-status':
      return this.handleStatusCommand(text, mapping);
  }
}

// Example: /eve review https://github.com/acme/app/pull/123
async handleEveCommand(text: string, context: SlackContext) {
  const intent = await this.parseIntent(text);  // Could use Claude Agent SDK here

  await this.db.orchestration_requests.create({
    org_id: context.user.org_id,
    user_id: context.user.id,
    worker_type: intent.worker_type,
    prompt: intent.prompt,
    reply_to: {
      type: 'slack',
      channel: context.channel,
      thread_ts: context.thread_ts,
    },
    metadata: intent.metadata,
  });

  return {
    response_type: 'in_channel',
    text: `Got it! Working on: ${intent.summary}`,
  };
}
```

### HITL via Slack

```typescript
// When a HITL question is created, notify via Slack
async sendHitlQuestion(hitl: HitlRequest) {
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Question from Eve:*\n${hitl.question}` },
    },
  ];

  if (hitl.options) {
    blocks.push({
      type: 'actions',
      elements: hitl.options.map((opt, i) => ({
        type: 'button',
        text: { type: 'plain_text', text: opt.label },
        action_id: `hitl_response_${hitl.id}_${i}`,
        value: JSON.stringify({ hitl_id: hitl.id, value: opt.value }),
      })),
    });
  }

  await this.slack.chat.postMessage({
    channel: hitl.reply_to.channel,
    thread_ts: hitl.reply_to.thread_ts,
    blocks,
  });
}

// Handle button click
async handleHitlResponse(payload: SlackInteractionPayload) {
  const { hitl_id, value } = JSON.parse(payload.actions[0].value);

  await this.db.hitl_requests.update(hitl_id, {
    status: 'answered',
    response: { value },
    responded_at: new Date(),
    responded_by: await this.getSlackUserMapping(payload.user.id),
  });

  // Re-queue the original request
  await this.db.orchestration_requests.update(
    (await this.db.hitl_requests.get(hitl_id)).request_id,
    { status: 'pending' }
  );

  return { text: 'Thanks! Continuing...' };
}
```

---

## Realtime Updates (Supabase Realtime)

For live dashboards and real-time status:

```typescript
// Frontend: Subscribe to project updates
const channel = supabase
  .channel(`project:${projectId}`)
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'orchestration_requests',
    filter: `project_id=eq.${projectId}`,
  }, (payload) => {
    updateTaskList(payload);
  })
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'orchestration_results',
    filter: `project_id=eq.${projectId}`,
  }, (payload) => {
    showResultNotification(payload);
  })
  .subscribe();
```

---

## Why This Is Elegant

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  1. ONE PATTERN, MULTIPLE HORIZONS                              │
│     Projects, tasks, and notifications all use the same        │
│     queue/worker pattern. Just different time horizons.        │
│                                                                 │
│  2. SUPABASE DOES THE HEAVY LIFTING                             │
│     Auth, RLS, PGMQ, Realtime, Kong — all built-in.            │
│     No Redis, no RabbitMQ, no external message brokers.        │
│                                                                 │
│  3. WORKER TYPES = DOCKER IMAGES                                │
│     Adding a new capability = building a new Docker image.     │
│     No code changes to the platform itself.                    │
│                                                                 │
│  4. STATELESS WORKERS                                           │
│     All state is in Postgres. Workers can crash and restart.   │
│     PGMQ handles notification delivery guarantees.             │
│                                                                 │
│  5. TENANT CONTEXT IS JUST METADATA                             │
│     (org_id, user_id) flow through as env vars.                │
│     RLS ensures isolation at the database level.               │
│                                                                 │
│  6. SLACK IS A FIRST-CLASS CITIZEN                              │
│     reply_to routing means any interface (Slack, webhook, UI)  │
│     uses the same underlying request/result flow.              │
│                                                                 │
│  7. HITL IS BUILT INTO THE CORE                                 │
│     Workers can pause, ask questions, and resume.              │
│     Same pattern for Slack buttons and web forms.              │
│                                                                 │
│  8. mclaude IS THE EXECUTION ENGINE                             │
│     We orchestrate mclaude, not build agent logic.             │
│     All the Claude magic is already there.                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Open Questions

1. **Worker type discovery**: How do projects know what worker types are available? Query `worker_types` table?
2. **Cost attribution**: Track tokens per org/project/user? Supabase usage API?
3. **Worker affinity**: Should tasks from the same project prefer the same worker? (Better context cache)
4. **Plan format**: Structured JSON task graph or freeform markdown? (Leaning freeform for AI flexibility)
5. **Secret management**: Vault integration? Supabase Vault? Per-org encrypted secrets table?
6. **Rate limiting**: Per-org concurrent request limits? Per-project? Both?
7. **Retry policy**: How many retries for failed tasks? Exponential backoff?
8. **Audit log**: Full audit trail of all requests/results? Compliance requirements?

---

## MVP Phases

### Phase 1: Core Platform
- [ ] Supabase project setup (Auth, DB, PGMQ, RLS)
- [ ] Organizations, members, RLS policies
- [ ] `worker_types` table with 2-3 initial types
- [ ] Extended `orchestration_requests` with `worker_type`, `reply_to`
- [ ] `orchestration_results` table with metrics
- [ ] Control plane NestJS service (basic API)
- [ ] General-purpose worker Docker image
- [ ] Basic claim/process/result flow

### Phase 2: Slack Integration
- [ ] Slack app registration
- [ ] `slack_installations` and user mappings
- [ ] PGMQ notification queues
- [ ] Slack notifier service
- [ ] `/eve` slash command
- [ ] Thread-based replies

### Phase 3: HITL
- [ ] `hitl_requests` table
- [ ] `waiting_input` status handling
- [ ] Slack button interactions
- [ ] Request re-queueing after response

### Phase 4: Projects
- [ ] `projects` table
- [ ] Project orchestrator worker
- [ ] Multi-repo support
- [ ] Plan document management
- [ ] Project → task hierarchy

### Phase 5: Specialized Workers
- [ ] Playwright worker (web crawling)
- [ ] Code-review worker (GitHub integration)
- [ ] Data worker (Python/pandas)
- [ ] Worker capability discovery

### Phase 6: Polish
- [ ] Realtime dashboard
- [ ] Cost tracking
- [ ] Auto-scaling (KEDA or similar)
- [ ] Observability (OpenTelemetry)
- [ ] Rate limiting

---

## Tech Stack Summary

| Component | Technology |
|-----------|------------|
| Auth | Supabase Auth (GoTrue) |
| Database | Supabase PostgreSQL |
| Message Queue | PGMQ (Supabase Queues) |
| Realtime | Supabase Realtime |
| API Gateway | Kong (via Supabase) |
| Control Plane | NestJS |
| Workers | Docker + mclaude |
| Primary Interface | Slack |
| Secondary Interface | REST API |
| Orchestration | mclaude with orchestration skill |

---

## References

- [Supabase PGMQ](https://supabase.com/docs/guides/queues/pgmq) - Native Postgres message queue
- [Supabase Realtime Broadcast](https://supabase.com/docs/guides/realtime/broadcast) - Low-latency pub/sub
- [Supabase Realtime Presence](https://supabase.com/docs/guides/realtime/presence) - Track online users
- [Supabase Queues](https://supabase.com/docs/guides/queues) - Full queue documentation

---

*Living document - update as we learn.*
