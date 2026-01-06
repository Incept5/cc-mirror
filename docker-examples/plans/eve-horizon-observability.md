# eve-horizon Observability Architecture

> **Status**: Brainstorming
> **Focus**: How to achieve full observability across the eve-horizon platform

## What Claude Code Provides Natively

Claude Code has **comprehensive built-in observability** that we can leverage:

### 1. OpenTelemetry (OTel) Support

```bash
# Enable telemetry (opt-in)
export CLAUDE_CODE_ENABLE_TELEMETRY=1

# Configure exporters
export OTEL_METRICS_EXPORTER=otlp        # otlp, prometheus, console
export OTEL_LOGS_EXPORTER=otlp           # otlp, console
export OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
```

**Available Metrics:**

| Metric | Description |
|--------|-------------|
| `claude_code.session.count` | CLI sessions started |
| `claude_code.token.usage` | Tokens used (input/output/cache) |
| `claude_code.cost.usage` | Session cost in USD |
| `claude_code.lines_of_code.count` | Lines modified |
| `claude_code.commit.count` | Commits created |
| `claude_code.pull_request.count` | PRs created |
| `claude_code.active_time.total` | Active usage time (seconds) |
| `claude_code.code_edit_tool.decision` | Tool accept/reject decisions |

**Available Events:**

| Event | Description |
|-------|-------------|
| `claude_code.user_prompt` | User prompt submitted (length, content if enabled) |
| `claude_code.tool_result` | Tool execution (name, success, duration_ms) |
| `claude_code.api_request` | API call (model, cost, tokens) |
| `claude_code.api_error` | API failure (error, status_code, attempt) |
| `claude_code.tool_decision` | Permission decision (config/user) |

### 2. Hooks System (10 Event Types)

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLAUDE CODE HOOKS                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  SessionStart      → Session begins/resumes                     │
│  SessionEnd        → Session ends                               │
│  UserPromptSubmit  → User submits prompt                        │
│  PreToolUse        → Before tool execution (can modify!)        │
│  PostToolUse       → After tool completion                      │
│  PermissionRequest → Permission dialog shown                    │
│  Notification      → Claude sends notification                  │
│  Stop              → Claude finishes responding                 │
│  SubagentStop      → Subagent task completes                    │
│  PreCompact        → Before context compaction                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Hook Input (JSON via stdin):**
```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.json",
  "cwd": "/workspace",
  "hook_event_name": "PostToolUse",
  "tool_name": "Edit",
  "tool_input": {...},
  "tool_output": {...}
}
```

**Hook Response:**
- Exit code `0` → Success (stdout becomes context or response)
- Exit code `2` → Block action (stderr becomes error message)
- Other → Non-blocking error (logged)

### 3. Output Formats

```bash
# Human readable (default)
mclaude --output-format text "prompt"

# Full JSON for programmatic processing
mclaude --output-format json "prompt"

# Streaming JSON for real-time processing
mclaude --output-format stream-json "prompt"
```

---

## eve-horizon Observability Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EVE-HORIZON OBSERVABILITY                           │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     WORKER CONTAINERS                               │    │
│  │                                                                     │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │    │
│  │  │  Worker 1   │  │  Worker 2   │  │  Worker N   │                 │    │
│  │  │             │  │             │  │             │                 │    │
│  │  │  mclaude    │  │  mclaude    │  │  mclaude    │                 │    │
│  │  │    ↓        │  │    ↓        │  │    ↓        │                 │    │
│  │  │  OTel SDK   │  │  OTel SDK   │  │  OTel SDK   │                 │    │
│  │  │    ↓        │  │    ↓        │  │    ↓        │                 │    │
│  │  │  Hooks      │  │  Hooks      │  │  Hooks      │                 │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                 │    │
│  │         │                │                │                         │    │
│  └─────────┼────────────────┼────────────────┼─────────────────────────┘    │
│            │                │                │                              │
│            └────────────────┼────────────────┘                              │
│                             │                                               │
│                             ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    OTEL COLLECTOR (SIDECAR)                         │    │
│  │                                                                     │    │
│  │  Receives: metrics, logs, traces from all workers                  │    │
│  │  Enriches: adds request_id, org_id, worker_type, project_id        │    │
│  │  Exports: to configured backends                                   │    │
│  │                                                                     │    │
│  └───────────────────────────┬─────────────────────────────────────────┘    │
│                              │                                              │
│            ┌─────────────────┼─────────────────┐                            │
│            │                 │                 │                            │
│            ▼                 ▼                 ▼                            │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐                │
│  │    Supabase     │ │   Prometheus    │ │     Grafana     │                │
│  │    (logs +      │ │   (metrics)     │ │   (dashboards)  │                │
│  │    audit trail) │ │                 │ │                 │                │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Strategy

### 1. Worker Container Configuration

```dockerfile
# In worker Dockerfile
ENV CLAUDE_CODE_ENABLE_TELEMETRY=1
ENV OTEL_METRICS_EXPORTER=otlp
ENV OTEL_LOGS_EXPORTER=otlp
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
ENV OTEL_EXPORTER_OTLP_PROTOCOL=grpc

# Enable prompt logging for debugging (careful with PII!)
# ENV OTEL_LOG_USER_PROMPTS=1

# Resource attributes for filtering
ENV OTEL_RESOURCE_ATTRIBUTES="service.name=eve-worker,service.version=1.0.0"
```

### 2. Dynamic Resource Attributes

The queue worker injects request context into mclaude environment:

```typescript
// In queue worker, before spawning mclaude
function buildOtelEnv(request: Request): Record<string, string> {
  const attributes = [
    `eve.request_id=${request.id}`,
    `eve.org_id=${request.org_id}`,
    `eve.user_id=${request.user_id}`,
    `eve.worker_type=${request.worker_type}`,
    request.project_id ? `eve.project_id=${request.project_id}` : null,
  ].filter(Boolean).join(',');

  return {
    OTEL_RESOURCE_ATTRIBUTES: attributes,
    // Also set as regular env vars for hooks
    EVE_REQUEST_ID: request.id,
    EVE_ORG_ID: request.org_id,
  };
}
```

### 3. Custom Hooks for eve-horizon

Create hooks that emit eve-specific events:

```bash
#!/bin/bash
# /hooks/eve-session-start.sh
# Called via SessionStart hook

# Parse input JSON
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')

# Log to eve system
eve telemetry emit \
  --event "eve.worker.session_start" \
  --attributes "{
    \"session_id\": \"$SESSION_ID\",
    \"request_id\": \"$EVE_REQUEST_ID\",
    \"worker_type\": \"$WORKER_TYPE\"
  }"

exit 0
```

```bash
#!/bin/bash
# /hooks/eve-tool-use.sh
# Called via PostToolUse hook

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
DURATION=$(echo "$INPUT" | jq -r '.duration_ms // 0')

# Log tool usage for analytics
eve telemetry emit \
  --event "eve.tool.used" \
  --attributes "{
    \"tool_name\": \"$TOOL_NAME\",
    \"duration_ms\": $DURATION,
    \"request_id\": \"$EVE_REQUEST_ID\"
  }"

exit 0
```

### 4. Hook Configuration in settings.json

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/hooks/eve-session-start.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/hooks/eve-tool-use.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/hooks/eve-session-end.sh"
          }
        ]
      }
    ]
  }
}
```

---

## Observability Tables (Supabase)

### Execution Logs

```sql
CREATE TABLE eve.execution_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),

    -- Context
    request_id      UUID NOT NULL REFERENCES eve.orchestration_requests(id),
    org_id          UUID NOT NULL,
    session_id      TEXT,

    -- Event
    event_type      TEXT NOT NULL,  -- 'session_start', 'tool_use', 'api_call', 'error', etc.
    event_data      JSONB NOT NULL,

    -- Metrics
    duration_ms     INTEGER,
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    cost_usd        NUMERIC(10,6)
);

CREATE INDEX idx_logs_request ON eve.execution_logs(request_id);
CREATE INDEX idx_logs_org_time ON eve.execution_logs(org_id, created_at);
CREATE INDEX idx_logs_event_type ON eve.execution_logs(event_type, created_at);
```

### Aggregated Metrics (for dashboards)

```sql
CREATE TABLE eve.metrics_hourly (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hour            TIMESTAMPTZ NOT NULL,
    org_id          UUID NOT NULL,
    worker_type     TEXT NOT NULL,

    -- Counters
    requests_total  INTEGER DEFAULT 0,
    requests_success INTEGER DEFAULT 0,
    requests_failed INTEGER DEFAULT 0,

    -- Gauges
    avg_duration_ms NUMERIC,
    p95_duration_ms NUMERIC,
    p99_duration_ms NUMERIC,

    -- Costs
    total_tokens_in  BIGINT DEFAULT 0,
    total_tokens_out BIGINT DEFAULT 0,
    total_cost_usd   NUMERIC(10,4) DEFAULT 0,

    UNIQUE (hour, org_id, worker_type)
);
```

### Audit Trail

```sql
CREATE TABLE eve.audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),

    -- Who
    org_id          UUID NOT NULL,
    user_id         UUID,
    worker_id       TEXT,

    -- What
    action          TEXT NOT NULL,  -- 'request.created', 'deployment.started', 'secret.accessed'
    resource_type   TEXT NOT NULL,  -- 'request', 'project', 'deployment', 'secret'
    resource_id     UUID,

    -- Details
    details         JSONB,
    ip_address      INET,
    user_agent      TEXT
);

CREATE INDEX idx_audit_org ON eve.audit_log(org_id, created_at);
CREATE INDEX idx_audit_resource ON eve.audit_log(resource_type, resource_id);
```

---

## OTel Collector Configuration

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 1000

  # Add eve-specific attributes
  attributes:
    actions:
      - key: platform
        value: eve-horizon
        action: insert

  # Filter out sensitive data
  filter:
    logs:
      exclude:
        match_type: regexp
        bodies:
          - ".*password.*"
          - ".*secret.*"
          - ".*token.*"

exporters:
  # Prometheus for metrics
  prometheus:
    endpoint: "0.0.0.0:8889"
    namespace: eve

  # PostgreSQL for logs (via HTTP to control plane)
  otlphttp:
    endpoint: http://control-plane:3000/v1/logs
    headers:
      Authorization: "Bearer ${OTEL_AUTH_TOKEN}"

  # Grafana Loki for log aggregation (optional)
  loki:
    endpoint: http://loki:3100/loki/api/v1/push

  # Debug output
  logging:
    verbosity: detailed

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch, attributes]
      exporters: [prometheus]
    logs:
      receivers: [otlp]
      processors: [batch, attributes, filter]
      exporters: [otlphttp, logging]
```

---

## Dashboard Metrics

### Per-Org Dashboard

```
┌─────────────────────────────────────────────────────────────────┐
│                    ACME CORP DASHBOARD                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Today                       This Month                         │
│  ────────────────            ────────────────                   │
│  Requests:     47            Requests:    1,234                 │
│  Success:      94%           Success:       97%                 │
│  Tokens:     125K            Tokens:      3.2M                  │
│  Cost:      $12.50           Cost:      $342.00                 │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Request Volume (24h)                                    │    │
│  │  ▃▅▇█▆▄▃▂▃▅▇█▇▅▄▃▂▁▁▂▃▄▅▆                               │    │
│  │  0h        6h       12h       18h       24h              │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  By Worker Type              By Status                          │
│  ────────────────            ────────────────                   │
│  general:     35             success:     44                    │
│  code-review:  8             failed:       2                    │
│  deployment:   4             timeout:      1                    │
│                                                                 │
│  Active Projects: 3                                             │
│  ────────────────                                               │
│  • Auth System (78% complete)                                   │
│  • API Refactor (45% complete)                                  │
│  • Docs Update (12% complete)                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Platform-Wide Dashboard (Admin)

```
┌─────────────────────────────────────────────────────────────────┐
│                    PLATFORM HEALTH                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Workers                     Queue Depth                        │
│  ────────────────            ────────────────                   │
│  general:   5/10 ███████░░░  pending:      23                   │
│  review:    2/5  ████░░░░░░  processing:    7                   │
│  deploy:    1/3  ███░░░░░░░  blocked:      12                   │
│                                                                 │
│  Latency (p95)               Error Rate                         │
│  ────────────────            ────────────────                   │
│  Claim:     45ms             API:        0.1%                   │
│  Execute: 12.3s              Worker:     0.5%                   │
│  Total:   15.2s              Timeout:    0.2%                   │
│                                                                 │
│  Cost by Org (Today)                                            │
│  ────────────────────────────────────────────────               │
│  acme-corp    ████████████████████  $45.20                      │
│  other-org    ██████████            $22.10                      │
│  dev-team     ████                   $8.50                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Alerting Rules

```yaml
# prometheus-alerts.yaml
groups:
  - name: eve-horizon
    rules:
      # High error rate
      - alert: HighErrorRate
        expr: |
          sum(rate(eve_requests_failed_total[5m])) /
          sum(rate(eve_requests_total[5m])) > 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value | humanizePercentage }}"

      # Worker queue backing up
      - alert: QueueBacklog
        expr: eve_pending_requests > 100
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Request queue backing up"
          description: "{{ $value }} pending requests"

      # Worker crash loop
      - alert: WorkerCrashLoop
        expr: |
          rate(eve_worker_restarts_total[5m]) > 0.5
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Workers restarting frequently"

      # Cost spike
      - alert: CostSpike
        expr: |
          sum(rate(eve_cost_usd_total[1h])) >
          2 * sum(rate(eve_cost_usd_total[1h] offset 1d))
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Unusual cost increase detected"

      # Stale requests
      - alert: StaleRequests
        expr: |
          eve_request_age_seconds{status="processing"} > 3600
        labels:
          severity: warning
        annotations:
          summary: "Requests stuck in processing"
```

---

## Transcript Storage

Claude Code creates transcripts at `transcript_path`. We can capture these:

```bash
#!/bin/bash
# /hooks/eve-session-end.sh

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path')

if [ -f "$TRANSCRIPT_PATH" ]; then
  # Upload transcript to storage
  eve storage upload \
    --bucket transcripts \
    --path "orgs/$EVE_ORG_ID/requests/$EVE_REQUEST_ID/transcript.json" \
    --file "$TRANSCRIPT_PATH"

  # Or store in database
  eve db execute \
    "INSERT INTO eve.transcripts (request_id, org_id, content) VALUES (\$1, \$2, \$3)" \
    "$EVE_REQUEST_ID" "$EVE_ORG_ID" "$(cat $TRANSCRIPT_PATH)"
fi

exit 0
```

---

## Privacy Considerations

```
┌─────────────────────────────────────────────────────────────────┐
│                    PRIVACY CONTROLS                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ALWAYS REDACTED (by Claude Code):                              │
│  • API keys and tokens                                          │
│  • File contents (unless OTEL_LOG_USER_PROMPTS=1)              │
│  • Sensitive tool outputs                                       │
│                                                                 │
│  CONFIGURABLE:                                                  │
│  • User prompts: Set OTEL_LOG_USER_PROMPTS=1 to include        │
│  • Tool inputs: Can be filtered in OTel collector              │
│  • Session IDs: OTEL_METRICS_INCLUDE_SESSION_ID               │
│                                                                 │
│  RECOMMENDATIONS FOR EVE-HORIZON:                               │
│  • Enable prompt logging only for debugging                    │
│  • Filter PII in OTel collector before storage                 │
│  • Use RLS on logs tables for org isolation                    │
│  • Implement audit log access controls                         │
│  • Consider transcript retention policies                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Basic Logging
- [ ] Configure workers with CLAUDE_CODE_ENABLE_TELEMETRY
- [ ] Deploy OTel collector as sidecar
- [ ] Create execution_logs table
- [ ] HTTP endpoint to receive logs

### Phase 2: Metrics
- [ ] Prometheus exporter from OTel collector
- [ ] Grafana dashboards (per-org, platform-wide)
- [ ] Basic alerting rules

### Phase 3: Hooks Integration
- [ ] SessionStart/End hooks for request tracking
- [ ] PostToolUse hooks for tool analytics
- [ ] Transcript capture and storage

### Phase 4: Advanced
- [ ] Cost attribution per org/project/user
- [ ] Anomaly detection
- [ ] SLA monitoring
- [ ] Audit log compliance features

---

## Key Insight

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   CLAUDE CODE IS ALREADY INSTRUMENTED                           │
│                                                                 │
│   We don't need to build observability from scratch.           │
│   Claude Code has:                                              │
│   • Full OTel support (metrics, logs, traces)                  │
│   • 10 hook event types for custom integration                 │
│   • Transcript files for replay/debugging                      │
│   • JSON output formats for programmatic processing            │
│                                                                 │
│   Our job is to:                                                │
│   1. Enable and configure what's already there                 │
│   2. Add eve-specific context (request_id, org_id, etc.)       │
│   3. Collect, store, and visualize in our platform             │
│   4. Build alerting and dashboards on top                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

*Observability: See everything, understand everything, fix everything quickly.*
