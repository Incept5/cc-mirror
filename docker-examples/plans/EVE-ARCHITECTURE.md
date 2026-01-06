# eve-horizon: Technical Architecture

> **Version**: 1.0
> **Status**: Foundational Blueprint
> **Purpose**: Standalone reference for building eve-horizon from scratch

---

## Vision

eve-horizon is an AI agent orchestration platform built on one elegant principle: **the platform is dumb, workers are smart**. The platform provides a queue, routing, and observability. Everything else - workflow logic, domain knowledge, state management - lives in skills attached to workers. Any cc-mirror variant (mclaude, zai, minimax, openrouter, ccrouter) can serve as the execution engine, making eve-horizon provider-agnostic by design.

---

## Core Primitives

### The Building Block: cc-mirror

[cc-mirror](https://github.com/numman-ali/cc-mirror) creates isolated Claude Code instances that connect to different AI providers. Each variant has complete isolation: its own config, sessions, API credentials, and themes.

```
+------------------------------------------------------------------------+
|                                                                        |
|   One tool. Multiple Claude Code instances. Complete isolation.        |
|                                                                        |
|   +----------+   +----------+   +----------+   +----------+            |
|   |   zai    |   | minimax  |   |openrouter|   | mclaude  |            |
|   |  GLM-4.7 |   |  M2.1    |   | 100+ LLMs|   |  Claude  |            |
|   +----+-----+   +----+-----+   +----+-----+   +----+-----+            |
|        |              |              |              |                   |
|        +--------------+--------------+--------------+                   |
|                              |                                          |
|                   +----------v----------+                               |
|                   |    Claude Code      |                               |
|                   |    (isolated)       |                               |
|                   +---------------------+                               |
|                                                                        |
+------------------------------------------------------------------------+
```

**Supported Providers:**

| Provider       | Models                 | Best For                       |
| -------------- | ---------------------- | ------------------------------ |
| **mclaude**    | Claude (native)        | Pure Claude with team mode     |
| **zai**        | GLM-4.7, GLM-4.5-Air   | Heavy coding with GLM          |
| **minimax**    | MiniMax-M2.1           | Unified model experience       |
| **openrouter** | 100+ models            | Model flexibility, pay-per-use |
| **ccrouter**   | Ollama, DeepSeek, etc. | Local-first development        |

**The Wrapper Pattern:**

Each variant installs as a shell command that wraps Claude Code with isolated configuration:

```bash
# Create a variant
npx cc-mirror quick --provider mirror --name mclaude

# The wrapper (installed at ~/.local/bin/mclaude)
mclaude --print "Your prompt here"  # Non-interactive execution
```

**Why This Matters for eve-horizon:**

- **Provider Agnostic**: Workers can use ANY cc-mirror variant
- **Cost Optimization**: Route to cheaper providers for simple tasks
- **Resilience**: Fail over between providers
- **Experimentation**: Test new models without platform changes

---

### The Queue

A single PostgreSQL table serves as the universal job queue. Simplicity is the point.

```sql
CREATE TABLE eve.orchestration_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),

    -- Tenant isolation
    org_id          UUID NOT NULL,
    user_id         UUID NOT NULL,

    -- Worker routing
    worker_type     TEXT NOT NULL DEFAULT 'general',
    status          TEXT DEFAULT 'pending',

    -- The work
    prompt          TEXT NOT NULL,
    context         JSONB DEFAULT '{}',

    -- Claim tracking
    claimed_at      TIMESTAMPTZ,
    claimed_by      TEXT
);

-- Workers poll by type
CREATE INDEX idx_requests_poll
    ON eve.orchestration_requests(worker_type, status, created_at)
    WHERE status = 'pending';
```

**Status Lifecycle:**

```
pending --> claimed --> processing --> completed
                                   --> failed
                                   --> waiting (for HITL or children)
```

**The Claim Pattern (SKIP LOCKED):**

```sql
CREATE OR REPLACE FUNCTION eve.claim_next_request(
    p_worker_type TEXT,
    p_worker_id TEXT
) RETURNS eve.orchestration_requests AS $$
DECLARE
    v_request eve.orchestration_requests;
BEGIN
    SELECT * INTO v_request
    FROM eve.orchestration_requests
    WHERE worker_type = p_worker_type
      AND status = 'pending'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF v_request IS NOT NULL THEN
        UPDATE eve.orchestration_requests
        SET status = 'claimed',
            claimed_at = now(),
            claimed_by = p_worker_id
        WHERE id = v_request.id;
    END IF;

    RETURN v_request;
END;
$$ LANGUAGE plpgsql;
```

`SKIP LOCKED` is the secret sauce - multiple workers can poll simultaneously without blocking each other.

---

### The Worker

Workers are stateless containers that poll the queue, claim requests, execute them via cc-mirror, and write results.

```typescript
// Simplified NestJS Worker Service
@Injectable()
export class WorkerService {
  private readonly workerId = `worker-${hostname()}-${process.pid}`;

  constructor(
    private readonly queue: QueueService,
    private readonly executor: ExecutorService,
  ) {}

  @Interval(5000) // Poll every 5 seconds
  async poll() {
    const workerType = process.env.WORKER_TYPE || 'general';
    const request = await this.queue.claimNext(workerType, this.workerId);

    if (!request) return;

    try {
      await this.queue.updateStatus(request.id, 'processing');
      const result = await this.executor.run(request);
      await this.queue.writeResult(request.id, 'success', result);
    } catch (error) {
      await this.queue.writeResult(request.id, 'failed', null, error);
    }
  }
}
```

**Executor Pattern:**

```typescript
@Injectable()
export class ExecutorService {
  async run(request: Request): Promise<ExecutionResult> {
    // Build environment with request context
    const env = {
      ...process.env,
      EVE_REQUEST_ID: request.id,
      EVE_ORG_ID: request.org_id,
      EVE_USER_ID: request.user_id,
      ...this.flattenContext(request.context),
    };

    // Determine which cc-mirror variant to use
    const variant = request.config?.variant || 'mclaude';

    // Spawn the variant in non-interactive mode
    const result = await execa(variant, [
      '--print',
      '--output-format', 'json',
      request.prompt,
    ], {
      env,
      cwd: request.workspace || '/workspace',
      timeout: request.config?.timeout_ms || 1800000,
    });

    return JSON.parse(result.stdout);
  }
}
```

**Worker Lifecycle:**

```
+------------------+     +------------------+     +------------------+
|  Start Container |---->|   Poll Queue     |---->|  Claim Request   |
+------------------+     +------------------+     +--------+---------+
                              ^                           |
                              |                           v
                              |                  +------------------+
                              |                  | Inject EVE_* env |
                              |                  +--------+---------+
                              |                           |
                              |                           v
                              |                  +------------------+
                              |                  | Spawn cc-mirror  |
                              |                  +--------+---------+
                              |                           |
                              |                           v
                              |                  +------------------+
                              +------------------| Write Result     |
                                                 +------------------+
```

---

### Worker Types

Workers are specialized by capability. A registry table tracks what's available:

```sql
CREATE TABLE eve.worker_types (
    id              TEXT PRIMARY KEY,           -- 'general', 'code-review'
    name            TEXT NOT NULL,
    docker_image    TEXT NOT NULL,
    capabilities    TEXT[] DEFAULT '{}',
    config          JSONB DEFAULT '{}'
);

-- Example entries
INSERT INTO eve.worker_types (id, name, docker_image, capabilities) VALUES
    ('general',     'General Purpose',   'eve/worker-general:latest',    '{"git", "code"}'),
    ('code-review', 'Code Reviewer',     'eve/worker-code-review:latest','{"git", "github-api"}'),
    ('playwright',  'Web Automation',    'eve/worker-playwright:latest', '{"browser", "screenshot"}'),
    ('data',        'Data Analysis',     'eve/worker-data:latest',       '{"python", "pandas"}');
```

**Docker Image Structure:**

```dockerfile
# All workers extend a common base
FROM eve/worker-base:latest

# Worker-specific tools
RUN apt-get install -y python3 python3-pip
RUN pip3 install pandas numpy matplotlib

# Worker-specific skills
COPY skills/data-analysis/SKILL.md \
    /root/.cc-mirror/mc/config/skills/data-analysis/SKILL.md

ENV WORKER_TYPE=data
```

---

### Multi-Tenancy

Two tables. That's it.

```sql
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
    role            TEXT DEFAULT 'member',  -- owner, admin, member
    PRIMARY KEY (org_id, user_id)
);
```

**Row-Level Security (RLS):**

Every tenant-scoped table includes `org_id`. RLS policies enforce isolation:

```sql
-- Enable RLS
ALTER TABLE eve.orchestration_requests ENABLE ROW LEVEL SECURITY;

-- Isolation policy
CREATE POLICY org_isolation ON eve.orchestration_requests
    USING (org_id IN (
        SELECT org_id FROM eve.org_members
        WHERE user_id = auth.uid()
    ));

-- Service role bypass (for workers)
CREATE POLICY service_bypass ON eve.orchestration_requests
    FOR ALL
    TO service_role
    USING (true);
```

---

### The Result

```sql
CREATE TABLE eve.orchestration_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL REFERENCES eve.orchestration_requests(id),
    org_id          UUID NOT NULL,

    -- Outcome
    status          TEXT NOT NULL,      -- success, failed, timeout
    output          JSONB,              -- Full structured output
    summary         TEXT,               -- Human-readable summary

    -- Metrics
    duration_ms     INTEGER,
    tokens_used     INTEGER,
    cost_usd        NUMERIC(10,6),

    -- Error details (if failed)
    error           TEXT,
    error_code      TEXT,

    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_results_request ON eve.orchestration_results(request_id);
```

---

## The Pattern

Everything flows through one pattern:

```
+--------------------------------------------------------------------------+
|                                                                          |
|   HTTP Request    eve.orchestration    Worker      cc-mirror    Result   |
|   (with JWT)  --> requests table   --> claims  --> variant  --> output   |
|                   (org_id, user_id)    work        executes              |
|                                                                          |
+--------------------------------------------------------------------------+

Detailed flow:

   Client                API              Queue           Worker        cc-mirror
     |                    |                 |                |              |
     |  POST /requests    |                 |                |              |
     |  Authorization:    |                 |                |              |
     |  Bearer <jwt>      |                 |                |              |
     |------------------->|                 |                |              |
     |                    |                 |                |              |
     |                    | INSERT INTO     |                |              |
     |                    | orchestration_  |                |              |
     |                    | requests        |                |              |
     |                    |---------------->|                |              |
     |                    |                 |                |              |
     |  { id: uuid }      |                 |                |              |
     |<-------------------|                 |                |              |
     |                    |                 |                |              |
     |                    |                 |  claim_next_   |              |
     |                    |                 |  request()     |              |
     |                    |                 |<---------------|              |
     |                    |                 |                |              |
     |                    |                 |  request row   |              |
     |                    |                 |--------------->|              |
     |                    |                 |                |              |
     |                    |                 |                |  spawn with  |
     |                    |                 |                |  EVE_* env   |
     |                    |                 |                |------------->|
     |                    |                 |                |              |
     |                    |                 |                |   execute    |
     |                    |                 |                |   prompt     |
     |                    |                 |                |              |
     |                    |                 |                |  JSON result |
     |                    |                 |                |<-------------|
     |                    |                 |                |              |
     |                    |                 |  INSERT INTO   |              |
     |                    |                 |  results       |              |
     |                    |                 |<---------------|              |
     |                    |                 |                |              |
```

---

## Deployment Modes

### Development: Docker Compose

Single file, full stack, local iteration.

```yaml
# docker-compose.yml
version: '3.8'

services:
  db:
    image: postgres:15
    environment:
      POSTGRES_DB: eve
      POSTGRES_USER: eve
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./sql/init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"

  api:
    build: ./apps/api
    environment:
      DATABASE_URL: postgres://eve:${DB_PASSWORD}@db:5432/eve
      JWT_SECRET: ${JWT_SECRET}
    ports:
      - "3000:3000"
    depends_on:
      - db

  worker-general:
    build: ./apps/worker
    environment:
      DATABASE_URL: postgres://eve:${DB_PASSWORD}@db:5432/eve
      WORKER_TYPE: general
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    depends_on:
      - db
    deploy:
      replicas: 2

  worker-code-review:
    build:
      context: ./apps/worker
      dockerfile: Dockerfile.code-review
    environment:
      DATABASE_URL: postgres://eve:${DB_PASSWORD}@db:5432/eve
      WORKER_TYPE: code-review
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      GH_TOKEN: ${GH_TOKEN}
    depends_on:
      - db

volumes:
  postgres_data:
```

**Start development:**

```bash
docker-compose up -d
docker-compose logs -f worker-general
```

---

### Production: Kubernetes

Same components, different orchestration.

```yaml
# k8s/worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: eve-worker-general
  namespace: eve-horizon
spec:
  replicas: 3
  selector:
    matchLabels:
      app: eve-worker
      worker-type: general
  template:
    metadata:
      labels:
        app: eve-worker
        worker-type: general
    spec:
      containers:
      - name: worker
        image: eve/worker-general:latest
        env:
        - name: WORKER_TYPE
          value: "general"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: eve-secrets
              key: database-url
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: eve-secrets
              key: anthropic-api-key
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "2Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
```

**HPA for Auto-Scaling:**

```yaml
# k8s/worker-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: eve-worker-general-hpa
  namespace: eve-horizon
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: eve-worker-general
  minReplicas: 1
  maxReplicas: 20
  metrics:
  - type: External
    external:
      metric:
        name: eve_pending_requests
        selector:
          matchLabels:
            worker_type: general
      target:
        type: AverageValue
        averageValue: "5"
```

**KEDA for Scale-to-Zero:**

```yaml
# k8s/worker-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: eve-worker-general-scaler
  namespace: eve-horizon
spec:
  scaleTargetRef:
    name: eve-worker-general
  minReplicaCount: 0
  maxReplicaCount: 50
  triggers:
  - type: postgresql
    metadata:
      connectionFromEnv: DATABASE_URL
      query: |
        SELECT COUNT(*) FROM eve.orchestration_requests
        WHERE worker_type = 'general' AND status = 'pending'
      targetQueryValue: "5"
```

**Same Code, Different Scale:**

| Aspect | Docker Compose | Kubernetes |
|--------|----------------|------------|
| Scaling | Manual `--scale` | HPA/KEDA auto |
| Secrets | `.env` file | K8s Secrets |
| Networking | Docker network | Service mesh |
| Persistence | Local volumes | PVCs |
| Monitoring | Container logs | Prometheus/Grafana |
| Code | **Identical** | **Identical** |

---

## Observability (Built-In)

### Metrics

Claude Code has native OpenTelemetry support. We enable and extend it.

```bash
# Worker container environment
ENV CLAUDE_CODE_ENABLE_TELEMETRY=1
ENV OTEL_METRICS_EXPORTER=otlp
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
```

**Key Metrics:**

| Metric | Description |
|--------|-------------|
| `eve_requests_total` | Total requests by worker_type, status |
| `eve_request_duration_seconds` | Request processing time histogram |
| `eve_queue_depth` | Pending requests by worker_type |
| `eve_tokens_total` | Tokens used (input/output) |
| `eve_cost_usd_total` | Total cost by org, worker_type |
| `eve_worker_claims_total` | Successful/failed claims |

**OTel Collector Config:**

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  batch:
    timeout: 5s

exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"
    namespace: eve

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
```

---

### Logging

Structured JSON logs with request correlation.

```typescript
// Structured log format
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "level": "info",
  "message": "Request claimed",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "org_id": "org-123",
  "worker_type": "general",
  "worker_id": "worker-abc-1234"
}
```

**Log Aggregation:**

```yaml
# Workers ship logs to central store
services:
  worker-general:
    logging:
      driver: "fluentd"
      options:
        fluentd-address: "fluentd:24224"
        tag: "eve.worker.{{.Name}}"
```

---

### The Debug CLI: eve-cli

A command-line tool for debugging remote deployments.

```bash
# Installation
npm install -g @eve-horizon/cli

# Configure
eve config set api-url https://api.eve-horizon.example.com
eve config set api-key <your-api-key>
```

**Core Commands:**

```bash
# Request lifecycle
eve request list                     # List recent requests
eve request get <uuid>               # Request details
eve request logs <uuid>              # Stream execution logs

# Results
eve result get <uuid>                # Get result by request ID
eve result output <uuid>             # Raw output (for piping)

# Queue health
eve status                           # Overall platform health
eve queue                            # Queue depth by worker type

# Worker monitoring
eve workers                          # List active workers
eve workers logs <worker-id>         # Worker logs

# Live streaming
eve tail                             # All requests (firehose)
eve tail --worker-type general       # Filter by type
eve tail --org acme-corp             # Filter by org

# Debugging
eve logs --request-id <uuid>         # Fetch all logs for request
eve replay <uuid>                    # Re-run a failed request
```

**Example Session:**

```bash
$ eve status
+-------------------+--------+
| Component         | Status |
+-------------------+--------+
| API               | OK     |
| Database          | OK     |
| Workers (general) | 5/5    |
| Workers (review)  | 2/2    |
+-------------------+--------+

Queue Depth:
  general:     12 pending
  code-review:  3 pending

$ eve request get 550e8400-e29b-41d4-a716-446655440000
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "worker_type": "general",
  "prompt": "Review the auth module",
  "duration_ms": 45230,
  "tokens_used": 12500,
  "created_at": "2024-01-15T10:30:00Z"
}

$ eve logs --request-id 550e8400-e29b-41d4-a716-446655440000
[10:30:00] Claimed by worker-abc-1234
[10:30:01] Spawning mclaude variant
[10:30:02] Loading skill: orchestration
[10:30:05] Tool call: Read /src/auth/index.ts
[10:30:08] Tool call: Grep "password" /src/**/*.ts
...
[10:30:45] Execution complete
```

---

## Repository Structure

```
eve-horizon/
|
+-- apps/
|   +-- api/                         # NestJS control plane
|   |   +-- src/
|   |   |   +-- auth/                # JWT validation, org membership
|   |   |   +-- requests/            # Request CRUD
|   |   |   +-- results/             # Result queries
|   |   |   +-- workers/             # Worker status
|   |   |   +-- health/              # Health checks
|   |   +-- Dockerfile
|   |   +-- package.json
|   |
|   +-- worker/                      # Generic queue worker
|       +-- src/
|       |   +-- queue/               # Poll, claim, write
|       |   +-- executor/            # Spawn cc-mirror
|       |   +-- health/              # Liveness probes
|       +-- Dockerfile               # Base worker
|       +-- Dockerfile.code-review   # With GitHub tools
|       +-- Dockerfile.playwright    # With browser
|       +-- package.json
|
+-- packages/
|   +-- eve-cli/                     # Debug + management CLI
|   |   +-- src/
|   |   |   +-- commands/
|   |   |   |   +-- request.ts
|   |   |   |   +-- result.ts
|   |   |   |   +-- workers.ts
|   |   |   |   +-- status.ts
|   |   |   |   +-- tail.ts
|   |   |   +-- index.ts
|   |   +-- package.json
|   |
|   +-- shared/                      # Shared types, utilities
|       +-- src/
|       |   +-- types/
|       |   +-- database/
|       |   +-- utils/
|       +-- package.json
|
+-- infra/
|   +-- docker-compose.yml           # Dev deployment
|   +-- docker-compose.prod.yml      # Production-like local
|   +-- k8s/                         # Kubernetes manifests
|   |   +-- namespace.yaml
|   |   +-- secrets.yaml
|   |   +-- api-deployment.yaml
|   |   +-- worker-deployment.yaml
|   |   +-- worker-hpa.yaml
|   |   +-- ingress.yaml
|   +-- terraform/                   # Cloud provisioning (optional)
|       +-- aws/
|       +-- gcp/
|
+-- sql/
|   +-- init.sql                     # Schema creation
|   +-- migrations/                  # Incremental migrations
|
+-- skills/
|   +-- general/
|   |   +-- SKILL.md
|   +-- code-review/
|   |   +-- SKILL.md
|   +-- orchestration/
|       +-- SKILL.md
|
+-- .github/
|   +-- workflows/
|       +-- ci.yml                   # Test on PR
|       +-- deploy.yml               # Deploy on main
|
+-- tests/
|   +-- unit/
|   +-- integration/
|   +-- e2e/                         # Smoke tests with real agents
|
+-- .env.example
+-- README.md
+-- package.json                     # Monorepo root (turborepo/nx)
```

---

## CI/CD Pipeline

### On Pull Request

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Type check
        run: npm run typecheck

      - name: Unit tests
        run: npm run test:unit

      - name: Integration tests (mocked)
        run: npm run test:integration

  build:
    runs-on: ubuntu-latest
    needs: lint-and-test
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build API image
        uses: docker/build-push-action@v5
        with:
          context: ./apps/api
          push: false
          tags: eve/api:pr-${{ github.event.number }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Build Worker image
        uses: docker/build-push-action@v5
        with:
          context: ./apps/worker
          push: false
          tags: eve/worker-general:pr-${{ github.event.number }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### On Main (After Merge)

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_PREFIX: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      api-image: ${{ steps.meta-api.outputs.tags }}
      worker-image: ${{ steps.meta-worker.outputs.tags }}
    steps:
      - uses: actions/checkout@v4

      - name: Log in to registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract API metadata
        id: meta-api
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}/api
          tags: |
            type=sha,prefix=
            type=raw,value=latest

      - name: Build and push API
        uses: docker/build-push-action@v5
        with:
          context: ./apps/api
          push: true
          tags: ${{ steps.meta-api.outputs.tags }}
          labels: ${{ steps.meta-api.outputs.labels }}

      - name: Extract Worker metadata
        id: meta-worker
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}/worker-general
          tags: |
            type=sha,prefix=
            type=raw,value=latest

      - name: Build and push Worker
        uses: docker/build-push-action@v5
        with:
          context: ./apps/worker
          push: true
          tags: ${{ steps.meta-worker.outputs.tags }}
          labels: ${{ steps.meta-worker.outputs.labels }}

  e2e-smoke-tests:
    runs-on: ubuntu-latest
    needs: build-and-push
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Start test environment
        run: |
          docker-compose -f infra/docker-compose.yml up -d
          sleep 30  # Wait for services

      - name: Run E2E smoke tests
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          EVE_API_URL: http://localhost:3000
        run: npm run test:e2e

      - name: Collect logs on failure
        if: failure()
        run: docker-compose -f infra/docker-compose.yml logs

  deploy-staging:
    runs-on: ubuntu-latest
    needs: e2e-smoke-tests
    environment: staging
    steps:
      - uses: actions/checkout@v4

      - name: Setup kubectl
        uses: azure/setup-kubectl@v3

      - name: Configure kubeconfig
        run: |
          echo "${{ secrets.KUBE_CONFIG_STAGING }}" | base64 -d > kubeconfig
          export KUBECONFIG=kubeconfig

      - name: Deploy to staging
        run: |
          kubectl set image deployment/eve-api \
            api=${{ needs.build-and-push.outputs.api-image }} \
            -n eve-staging
          kubectl set image deployment/eve-worker-general \
            worker=${{ needs.build-and-push.outputs.worker-image }} \
            -n eve-staging
          kubectl rollout status deployment/eve-api -n eve-staging
          kubectl rollout status deployment/eve-worker-general -n eve-staging

      - name: Health check
        run: |
          sleep 30
          curl -f https://staging.eve-horizon.example.com/health

  deploy-production:
    runs-on: ubuntu-latest
    needs: deploy-staging
    environment: production
    steps:
      - uses: actions/checkout@v4

      - name: Setup kubectl
        uses: azure/setup-kubectl@v3

      - name: Configure kubeconfig
        run: |
          echo "${{ secrets.KUBE_CONFIG_PRODUCTION }}" | base64 -d > kubeconfig
          export KUBECONFIG=kubeconfig

      - name: Deploy to production
        run: |
          kubectl set image deployment/eve-api \
            api=${{ needs.build-and-push.outputs.api-image }} \
            -n eve-production
          kubectl set image deployment/eve-worker-general \
            worker=${{ needs.build-and-push.outputs.worker-image }} \
            -n eve-production
          kubectl rollout status deployment/eve-api -n eve-production
          kubectl rollout status deployment/eve-worker-general -n eve-production

      - name: Production health check
        run: |
          sleep 30
          curl -f https://api.eve-horizon.example.com/health
```

---

## E2E Smoke Tests

Real agents, real API keys, real verification.

```typescript
// tests/e2e/smoke.test.ts
import { describe, test, expect, beforeAll } from 'vitest';

const API_URL = process.env.EVE_API_URL || 'http://localhost:3000';
const API_KEY = process.env.EVE_E2E_API_KEY;

describe('E2E Smoke Tests', () => {
  let authToken: string;

  beforeAll(async () => {
    // Authenticate
    const res = await fetch(`${API_URL}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY }),
    });
    const data = await res.json();
    authToken = data.token;
  });

  test('worker processes request successfully', async () => {
    // Create request
    const createRes = await fetch(`${API_URL}/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        workerType: 'general',
        prompt: 'Echo "smoke test passed" using the Bash tool',
      }),
    });

    expect(createRes.status).toBe(201);
    const request = await createRes.json();
    expect(request.id).toBeDefined();

    // Poll for completion (max 60s)
    const result = await waitForResult(request.id, {
      timeout: 60000,
      authToken,
    });

    expect(result.status).toBe('success');
    expect(result.output).toBeDefined();
    expect(JSON.stringify(result.output)).toContain('smoke test passed');
  });

  test('code-review worker can access GitHub', async () => {
    const createRes = await fetch(`${API_URL}/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        workerType: 'code-review',
        prompt: 'Check if the GitHub CLI is working by running "gh auth status"',
      }),
    });

    const request = await createRes.json();
    const result = await waitForResult(request.id, {
      timeout: 60000,
      authToken,
    });

    expect(result.status).toBe('success');
    expect(JSON.stringify(result.output)).toContain('Logged in');
  });

  test('request with invalid worker type fails gracefully', async () => {
    const createRes = await fetch(`${API_URL}/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        workerType: 'nonexistent-worker',
        prompt: 'This should fail',
      }),
    });

    expect(createRes.status).toBe(400);
    const error = await createRes.json();
    expect(error.message).toContain('Invalid worker type');
  });
});

async function waitForResult(
  requestId: string,
  options: { timeout: number; authToken: string }
): Promise<any> {
  const startTime = Date.now();

  while (Date.now() - startTime < options.timeout) {
    const res = await fetch(`${API_URL}/results/${requestId}`, {
      headers: { 'Authorization': `Bearer ${options.authToken}` },
    });

    if (res.status === 200) {
      return res.json();
    }

    if (res.status === 404) {
      // Not ready yet, wait and retry
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    throw new Error(`Unexpected status: ${res.status}`);
  }

  throw new Error(`Timeout waiting for result: ${requestId}`);
}
```

---

## VPS Quick Start

Deploy to a single VPS for small teams or development.

```bash
# Clone the repository
git clone https://github.com/your-org/eve-horizon
cd eve-horizon

# Configure environment
cp .env.example .env
```

**Edit `.env`:**

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...
DB_PASSWORD=<strong-password>
JWT_SECRET=<random-32-chars>

# Optional: GitHub integration
GH_TOKEN=ghp_...

# Optional: Alternative providers
Z_AI_API_KEY=...
OPENROUTER_API_KEY=...
```

**Start the stack:**

```bash
# Pull/build images and start
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

**Verify installation:**

```bash
# Install CLI
npm install -g @eve-horizon/cli

# Configure CLI
eve config set api-url http://localhost:3000
eve config set api-key <your-api-key>

# Check platform status
eve status

# Submit a test request
eve request create \
  --worker-type general \
  --prompt "Echo hello world"

# Watch it process
eve tail
```

**Production Hardening:**

```bash
# Use production compose file
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Add reverse proxy (nginx/caddy) for HTTPS
# Configure backups for PostgreSQL volume
# Set up monitoring (prometheus/grafana or external service)
```

---

## Future Extensions (Not in MVP)

These capabilities are designed for but not implemented in the initial release:

### Task Dependencies (blocked_by)

```sql
ALTER TABLE eve.orchestration_requests ADD COLUMN
    blocked_by UUID[] DEFAULT '{}';
```

Platform-level support for task graphs: a request won't start until all blockers complete.

### Orchestrator Wake-up (reply_to)

```sql
-- reply_to types:
-- {type: 'orchestrator', request_id: '...'}

-- When child completes, wake up parent orchestrator
```

Event-driven orchestration: orchestrators EXIT when waiting, get woken up when children complete.

### HITL (Human-in-the-Loop)

```sql
CREATE TABLE eve.hitl_requests (
    id              UUID PRIMARY KEY,
    request_id      UUID NOT NULL,
    question        TEXT NOT NULL,
    options         JSONB,
    status          TEXT DEFAULT 'pending',
    response        JSONB,
    expires_at      TIMESTAMPTZ
);
```

Workers can pause, ask humans questions (via Slack, web UI, etc.), and resume.

### Scheduling (Cron)

```sql
CREATE TABLE eve.schedules (
    id              UUID PRIMARY KEY,
    cron_expression TEXT NOT NULL,
    request_template JSONB NOT NULL,
    enabled         BOOLEAN DEFAULT true
);
```

Create recurring requests on a schedule.

### Slack Integration

First-class Slack bot: `/eve review this PR`, threaded replies, button interactions.

---

## Design Principles

1. **One Pattern**

   Everything is a request in a queue. Simple tasks, complex orchestrations, scheduled jobs - same pattern.

2. **Provider Agnostic**

   Any cc-mirror variant works. Switch providers without platform changes.

3. **Skills Define Behavior**

   The platform is infrastructure. Skills (SKILL.md files) encode workflow logic, domain knowledge, and behavior.

4. **RLS as Safety Net**

   Database-level row isolation. Even if application code has bugs, data stays isolated per tenant.

5. **Same Code, Different Scale**

   docker-compose for dev, Kubernetes for prod. Identical worker code, different orchestration.

6. **Observability First**

   Telemetry isn't an afterthought. Every request, every tool call, every token - tracked and queryable.

7. **Fail Gracefully**

   Workers crash. Containers restart. Requests get re-queued. The system self-heals.

---

## Summary

eve-horizon is built on these primitives:

| Primitive | Purpose | Implementation |
|-----------|---------|----------------|
| **cc-mirror** | Provider-agnostic execution | Docker images with isolated Claude Code |
| **Queue** | Work distribution | PostgreSQL + SKIP LOCKED |
| **Worker** | Task execution | Stateless containers |
| **Worker Types** | Capability routing | Registry table |
| **Multi-tenancy** | Org isolation | RLS policies |
| **Results** | Outcome storage | Structured JSON |
| **Observability** | Debugging + monitoring | OTel + structured logs |
| **CLI** | Remote debugging | `eve-cli` commands |

The platform stays dumb. Workers stay smart. Skills define everything interesting.

---

*eve-horizon: Platform as infrastructure, skills as logic.*
