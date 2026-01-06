# eve-horizon v3: Kubernetes-Native Platform

> **Status**: Brainstorming v3
> **Builds on**: v2's "dumb platform, smart skills" philosophy
> **Adds**: Kubernetes for container orchestration + app lifecycle management

## What v3 Adds

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  v2 gave us:                                                    │
│    • Event-driven orchestration                                 │
│    • blocked_by + reply_to primitives                          │
│    • Skills define workflow, platform provides queue            │
│                                                                 │
│  v3 adds:                                                       │
│    • Kubernetes manages worker containers                       │
│    • Workers can deploy/manage OTHER apps                       │
│    • Full app lifecycle: deploy, scale, rollback, destroy       │
│    • Multi-cluster support (dev/staging/prod)                   │
│    • Same skills work on local k8s, EKS, GKE, ECS              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EVE-HORIZON v3                                 │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         SUPABASE (Control Plane DB)                   │  │
│  │                                                                       │  │
│  │  orchestration_requests    orchestration_results    worker_types      │  │
│  │  organizations             apps                     deployments       │  │
│  │  clusters                  environments                               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                        │                                    │
│                                        │                                    │
│  ┌─────────────────────────────────────┼─────────────────────────────────┐  │
│  │                     KUBERNETES CLUSTER(S)                             │  │
│  │                                     │                                 │  │
│  │  ┌──────────────────────────────────┴──────────────────────────────┐  │  │
│  │  │                    EVE-HORIZON NAMESPACE                        │  │  │
│  │  │                                                                 │  │  │
│  │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │  │  │
│  │  │  │ Control     │  │ Worker Pool │  │ Worker Pool │             │  │  │
│  │  │  │ Plane Pod   │  │ (general)   │  │ (deploy)    │             │  │  │
│  │  │  │             │  │             │  │             │             │  │  │
│  │  │  │ • API       │  │ • 3 replicas│  │ • 2 replicas│             │  │  │
│  │  │  │ • Slack Bot │  │ • HPA auto  │  │ • k8s access│             │  │  │
│  │  │  │ • Notifier  │  │             │  │             │             │  │  │
│  │  │  └─────────────┘  └─────────────┘  └─────────────┘             │  │  │
│  │  │                                                                 │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │                    TENANT NAMESPACES                            │  │  │
│  │  │                                                                 │  │  │
│  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │  │  │
│  │  │  │ acme-corp-dev   │  │ acme-corp-prod  │  │ other-org-dev   │  │  │  │
│  │  │  │                 │  │                 │  │                 │  │  │  │
│  │  │  │ [User Apps]     │  │ [User Apps]     │  │ [User Apps]     │  │  │  │
│  │  │  │ • api-service   │  │ • api-service   │  │ • web-app       │  │  │  │
│  │  │  │ • web-frontend  │  │ • web-frontend  │  │ • worker        │  │  │  │
│  │  │  │ • worker        │  │ • worker        │  │                 │  │  │  │
│  │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘  │  │  │
│  │  │                                                                 │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### 1. Workers Run IN Kubernetes

```yaml
# eve-horizon workers are Kubernetes Deployments
apiVersion: apps/v1
kind: Deployment
metadata:
  name: eve-worker-general
  namespace: eve-horizon
spec:
  replicas: 3  # Managed by HPA
  selector:
    matchLabels:
      app: eve-worker
      worker-type: general
  template:
    spec:
      containers:
      - name: worker
        image: eve-horizon/worker-general:latest
        env:
        - name: WORKER_TYPE
          value: "general"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: eve-secrets
              key: database-url
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "2Gi"
            cpu: "1000m"
```

### 2. Workers Can MANAGE Kubernetes

Some workers have RBAC permissions to deploy/manage apps:

```yaml
# ServiceAccount for deployment workers
apiVersion: v1
kind: ServiceAccount
metadata:
  name: eve-deployment-worker
  namespace: eve-horizon
---
# ClusterRole with limited permissions
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: eve-app-deployer
rules:
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["services", "configmaps", "secrets"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
---
# Bind to specific namespaces only
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: eve-deployer-binding
  namespace: acme-corp-dev  # Per-tenant namespace
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: eve-app-deployer
subjects:
- kind: ServiceAccount
  name: eve-deployment-worker
  namespace: eve-horizon
```

---

## New Database Tables

```sql
-- Kubernetes clusters registered with the platform
CREATE TABLE eve.clusters (
    id              TEXT PRIMARY KEY,           -- 'local', 'eks-prod', 'gke-eu'
    name            TEXT NOT NULL,
    provider        TEXT NOT NULL,              -- 'local', 'eks', 'gke', 'aks', 'ecs'
    endpoint        TEXT,                       -- API server URL (or null for in-cluster)
    credentials     JSONB,                      -- Encrypted kubeconfig or IAM role
    config          JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Environments map org → cluster → namespace
CREATE TABLE eve.environments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES eve.organizations(id),
    name            TEXT NOT NULL,              -- 'dev', 'staging', 'prod'
    cluster_id      TEXT NOT NULL REFERENCES eve.clusters(id),
    namespace       TEXT NOT NULL,              -- 'acme-corp-dev'
    config          JSONB DEFAULT '{}',         -- resource limits, etc.
    UNIQUE (org_id, name)
);

-- Apps registered on the platform
CREATE TABLE eve.apps (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES eve.organizations(id),
    name            TEXT NOT NULL,
    repo_url        TEXT,                       -- Source repo
    config          JSONB DEFAULT '{}',         -- Build config, defaults
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (org_id, name)
);

-- Deployment records
CREATE TABLE eve.deployments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id          UUID NOT NULL REFERENCES eve.apps(id),
    environment_id  UUID NOT NULL REFERENCES eve.environments(id),
    org_id          UUID NOT NULL,

    -- Deployment state
    status          TEXT DEFAULT 'pending',     -- pending, deploying, running, failed, stopped
    image           TEXT NOT NULL,              -- Docker image to deploy
    replicas        INTEGER DEFAULT 1,
    config          JSONB DEFAULT '{}',         -- env vars, resources, etc.

    -- Tracking
    deployed_at     TIMESTAMPTZ,
    deployed_by     UUID REFERENCES auth.users(id),
    request_id      UUID REFERENCES eve.orchestration_requests(id),

    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Deployment history
CREATE TABLE eve.deployment_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id   UUID NOT NULL REFERENCES eve.deployments(id),
    event_type      TEXT NOT NULL,              -- 'created', 'scaled', 'rolled_back', 'failed'
    details         JSONB,
    created_at      TIMESTAMPTZ DEFAULT now()
);
```

---

## CLI Extensions for Kubernetes

```bash
# ============================================
# CLUSTER MANAGEMENT (admin only)
# ============================================

eve cluster list
eve cluster add \
  --id eks-prod \
  --provider eks \
  --endpoint "https://xxx.eks.amazonaws.com"

# ============================================
# ENVIRONMENT MANAGEMENT
# ============================================

# List environments for current org
eve env list

# Create environment (admin)
eve env create \
  --name prod \
  --cluster eks-prod \
  --namespace "$ORG_SLUG-prod"

# ============================================
# APP MANAGEMENT
# ============================================

# Register an app
eve app create \
  --name api-service \
  --repo-url "git@github.com:acme/api.git"

# List apps
eve app list

# ============================================
# DEPLOYMENT OPERATIONS
# ============================================

# Deploy an app to an environment
eve deploy create \
  --app api-service \
  --env prod \
  --image "acme/api:v1.2.3" \
  --replicas 3

# Scale a deployment
eve deploy scale \
  --app api-service \
  --env prod \
  --replicas 5

# Rollback
eve deploy rollback \
  --app api-service \
  --env prod \
  --to-version "v1.2.2"

# Get deployment status
eve deploy status \
  --app api-service \
  --env prod

# View logs
eve deploy logs \
  --app api-service \
  --env prod \
  --tail 100

# ============================================
# KUBECTL PROXY (for advanced workers)
# ============================================

# Execute kubectl command in tenant namespace
eve kubectl --env prod get pods
eve kubectl --env prod describe deployment api-service
eve kubectl --env prod logs -f deployment/api-service
```

---

## Deployment Worker Type

```sql
INSERT INTO eve.worker_types (id, name, docker_image, capabilities, config) VALUES (
  'deployment',
  'Deployment Worker',
  'eve-horizon/worker-deployment:latest',
  '{"kubernetes", "helm", "kubectl", "docker"}',
  '{"service_account": "eve-deployment-worker"}'
);
```

### Deployment Worker SKILL.md

```markdown
# Deployment Worker

> **Load when**: Worker type is `deployment`

You manage application deployments on Kubernetes. You have access to kubectl
and can create, update, and manage Kubernetes resources in tenant namespaces.

## Your Capabilities

- Deploy Docker images to Kubernetes
- Scale deployments
- Rollback to previous versions
- View logs and pod status
- Manage ConfigMaps and Secrets
- Create Services and Ingresses

## Security Boundaries

You can ONLY operate within namespaces that belong to the requesting org.
The platform enforces this via RBAC - you physically cannot access other
tenants' namespaces.

## Tools

### Deploy Application

```bash
eve deploy create \
  --app "$APP_NAME" \
  --env "$ENV_NAME" \
  --image "$IMAGE" \
  --replicas 3 \
  --env-vars '{"DATABASE_URL": "...", "API_KEY": "..."}'
```

### Check Deployment Status

```bash
eve deploy status --app "$APP_NAME" --env "$ENV_NAME"
# Returns: {status, replicas: {desired, ready}, pods: [...]}
```

### Scale

```bash
eve deploy scale --app "$APP_NAME" --env "$ENV_NAME" --replicas 5
```

### Rollback

```bash
# List available versions
eve deploy history --app "$APP_NAME" --env "$ENV_NAME"

# Rollback
eve deploy rollback --app "$APP_NAME" --env "$ENV_NAME" --to-version "v1.2.2"
```

### Advanced: Direct kubectl

For complex operations, use kubectl directly:

```bash
eve kubectl --env "$ENV_NAME" apply -f deployment.yaml
eve kubectl --env "$ENV_NAME" get pods -l app=api-service
eve kubectl --env "$ENV_NAME" logs -f deployment/api-service
```

## Common Workflows

### Blue-Green Deployment

1. Deploy new version alongside old: `eve deploy create --app api-v2 ...`
2. Verify new version is healthy: `eve deploy status --app api-v2`
3. Switch traffic: Update ingress/service
4. Remove old version: `eve deploy delete --app api-v1`

### Canary Deployment

1. Deploy canary: `eve deploy create --app api-canary --replicas 1`
2. Monitor metrics
3. Gradually scale canary, reduce main
4. Promote or rollback

### Database Migration + Deploy

1. Run migration job
2. Wait for completion
3. Deploy new app version
4. Verify health
```

---

## DevOps Project Orchestrator

A higher-level orchestrator for full deployment pipelines:

```sql
INSERT INTO eve.worker_types (id, name, docker_image, schema_name, capabilities) VALUES (
  'devops-orchestrator',
  'DevOps Project Orchestrator',
  'eve-horizon/worker-devops-orchestrator:latest',
  'devops_projects',
  '{"deployment", "ci-cd", "multi-env", "rollout-strategies"}'
);
```

### DevOps Orchestrator SKILL.md

```markdown
# DevOps Project Orchestrator

> **Load when**: Worker type is `devops-orchestrator`

You orchestrate complex deployment workflows across multiple environments.
You coordinate builds, tests, deployments, and rollbacks.

## Event-Driven Model

Same as SE orchestrator: fire tasks, EXIT, wake on completion.

## Deployment Pipeline Pattern

```bash
# Typical pipeline:
# Build → Test → Deploy Dev → Integration Tests → Deploy Staging → Deploy Prod

eve request pipeline \
  --tasks '[
    {"worker_type": "general", "prompt": "Build Docker image from $REPO"},
    {"worker_type": "general", "prompt": "Run unit tests"},
    {"worker_type": "deployment", "prompt": "Deploy to dev environment"},
    {"worker_type": "general", "prompt": "Run integration tests against dev"},
    {"worker_type": "deployment", "prompt": "Deploy to staging environment"},
    {"worker_type": "general", "prompt": "Run smoke tests against staging"},
    {"worker_type": "deployment", "prompt": "Deploy to prod environment"}
  ]' \
  --context '{"app": "api-service", "version": "v1.2.3"}' \
  --reply-to-orchestrator
```

## Multi-Environment Rollout

```bash
# Deploy to dev first
DEV=$(eve request create \
  --worker-type deployment \
  --prompt "Deploy api-service:v1.2.3 to dev" \
  --context '{"app": "api-service", "env": "dev", "image": "v1.2.3"}' \
  | jq -r '.id')

# Staging blocked by dev success
STAGING=$(eve request create \
  --worker-type deployment \
  --prompt "Deploy api-service:v1.2.3 to staging" \
  --blocked-by "$DEV" \
  --context '{"app": "api-service", "env": "staging", "image": "v1.2.3"}' \
  | jq -r '.id')

# Prod blocked by staging success
eve request create \
  --worker-type deployment \
  --prompt "Deploy api-service:v1.2.3 to prod" \
  --blocked-by "$STAGING" \
  --context '{"app": "api-service", "env": "prod", "image": "v1.2.3"}' \
  --reply-to-orchestrator
```

## Canary with Auto-Rollback

```bash
# Create canary
CANARY=$(eve request create \
  --worker-type deployment \
  --prompt "Deploy canary: api-service:v1.2.3, 10% traffic" \
  --reply-to-orchestrator | jq -r '.id')

# On wake-up: check canary metrics
# If healthy: promote
# If errors: auto-rollback
```

## Managing State

```bash
# Track deployment in devops_projects schema
eve db execute --schema devops_projects \
  "INSERT INTO deployments (app, env, image, status) VALUES ($1, $2, $3, $4)" \
  "api-service" "prod" "v1.2.3" "in_progress"
```
```

---

## Auto-Scaling Workers with HPA

```yaml
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
  # Scale based on queue depth
  - type: External
    external:
      metric:
        name: eve_pending_requests
        selector:
          matchLabels:
            worker_type: general
      target:
        type: AverageValue
        averageValue: "5"  # 5 pending requests per worker
```

### KEDA for Event-Driven Scaling

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: eve-worker-general-scaler
  namespace: eve-horizon
spec:
  scaleTargetRef:
    name: eve-worker-general
  minReplicaCount: 0  # Scale to zero when idle!
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

---

## Multi-Cluster Support

### Provider Abstraction

```typescript
// eve-cli uses a provider abstraction for multi-cluster
interface ClusterProvider {
  deploy(spec: DeploymentSpec): Promise<DeploymentResult>;
  scale(app: string, replicas: number): Promise<void>;
  rollback(app: string, version: string): Promise<void>;
  getLogs(app: string, options: LogOptions): AsyncIterable<string>;
  getStatus(app: string): Promise<DeploymentStatus>;
}

class KubernetesProvider implements ClusterProvider {
  // kubectl-based implementation
}

class ECSProvider implements ClusterProvider {
  // AWS ECS-based implementation
}

class LocalDockerProvider implements ClusterProvider {
  // docker-compose for local dev
}
```

### Cluster Configuration

```sql
-- Different cluster types
INSERT INTO eve.clusters VALUES
  ('local', 'Local Development', 'local', NULL, NULL, '{}'),
  ('eks-prod', 'AWS EKS Production', 'eks', 'https://xxx.eks.amazonaws.com', '{"role_arn": "..."}', '{}'),
  ('gke-eu', 'GCP GKE Europe', 'gke', 'https://xxx.gke.google.com', '{"service_account": "..."}', '{}'),
  ('ecs-legacy', 'AWS ECS Legacy', 'ecs', NULL, '{"cluster": "legacy-cluster"}', '{}');
```

---

## Local Development Setup

### Option 1: Kind (Kubernetes in Docker)

```bash
# Create local cluster
kind create cluster --name eve-local

# Install eve-horizon
helm install eve-horizon ./charts/eve-horizon \
  --set database.external=true \
  --set database.url="$SUPABASE_URL" \
  --set workers.general.replicas=2
```

### Option 2: Minikube

```bash
minikube start --memory=4096 --cpus=2
minikube addons enable ingress
minikube addons enable metrics-server

helm install eve-horizon ./charts/eve-horizon
```

### Option 3: Docker Compose (No K8s)

```yaml
# For simple local dev without Kubernetes
version: '3.8'
services:
  control-plane:
    image: eve-horizon/control-plane:latest
    environment:
      - DATABASE_URL=${DATABASE_URL}
    ports:
      - "3000:3000"

  worker-general:
    image: eve-horizon/worker-general:latest
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - WORKER_TYPE=general
    deploy:
      replicas: 2

  worker-deployment:
    image: eve-horizon/worker-deployment:latest
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - WORKER_TYPE=deployment
      - KUBECONFIG=/kubeconfig
    volumes:
      - ~/.kube/config:/kubeconfig:ro
```

---

## Security Model

```
┌─────────────────────────────────────────────────────────────────┐
│                       SECURITY LAYERS                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. SUPABASE AUTH                                               │
│     User identity, org membership                               │
│                                                                 │
│  2. DATABASE RLS                                                │
│     Org isolation at data layer                                │
│                                                                 │
│  3. KUBERNETES NAMESPACES                                       │
│     Each org+env gets a namespace                              │
│     Workers can only access permitted namespaces               │
│                                                                 │
│  4. RBAC                                                        │
│     Deployment workers have limited ClusterRole                │
│     Bound only to specific namespaces                          │
│                                                                 │
│  5. NETWORK POLICIES                                            │
│     Tenant namespaces isolated from each other                 │
│     Only eve-horizon namespace can reach them                  │
│                                                                 │
│  6. SECRET MANAGEMENT                                           │
│     Kubernetes Secrets + External Secrets Operator             │
│     Or Vault integration                                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Network Policy Example

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: tenant-isolation
  namespace: acme-corp-prod
spec:
  podSelector: {}  # Apply to all pods in namespace
  policyTypes:
  - Ingress
  - Egress
  ingress:
  # Allow from ingress controller
  - from:
    - namespaceSelector:
        matchLabels:
          name: ingress-nginx
  # Allow from eve-horizon workers
  - from:
    - namespaceSelector:
        matchLabels:
          name: eve-horizon
  egress:
  # Allow DNS
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: UDP
      port: 53
  # Allow external APIs
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 10.0.0.0/8  # Block internal network
```

---

## Why v3?

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  1. WORKERS SCALE AUTOMATICALLY                                 │
│     HPA/KEDA scales workers based on queue depth               │
│     Scale to zero when idle (cost savings)                     │
│                                                                 │
│  2. WORKERS CAN DEPLOY APPS                                     │
│     Full DevOps automation: build → test → deploy              │
│     AI agents manage your infrastructure                       │
│                                                                 │
│  3. MULTI-TENANT BY DESIGN                                      │
│     Kubernetes namespaces provide hard isolation               │
│     Each org can have dev/staging/prod environments            │
│                                                                 │
│  4. PORTABLE                                                    │
│     Same skills work on local Kind, EKS, GKE, ECS             │
│     Provider abstraction handles differences                   │
│                                                                 │
│  5. PRODUCTION-READY                                            │
│     Health checks, resource limits, rolling updates            │
│     Built-in monitoring and logging                            │
│                                                                 │
│  6. STILL ELEGANT                                               │
│     Deployment is just another worker type                     │
│     DevOps orchestrator is just another skill                  │
│     Platform stays dumb, skills stay smart                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Comparison: v2 vs v3

| Aspect | v2 | v3 |
|--------|----|----|
| Worker management | Docker Compose | Kubernetes |
| Scaling | Manual replicas | HPA/KEDA auto-scale |
| App deployment | Not supported | First-class |
| Multi-env | Not supported | dev/staging/prod |
| Isolation | DB-level RLS | Namespaces + RBAC + Network |
| Local dev | docker-compose | Kind/Minikube/docker-compose |
| Production | docker-compose | EKS/GKE/AKS |
| Complexity | Lower | Higher |

**v2 is still valid** for:
- Simpler deployments
- Single-tenant use cases
- When you don't need app deployment features

**v3 adds value** when:
- You want auto-scaling workers
- You need to deploy/manage apps
- You have multiple environments
- You need stronger isolation

---

## MVP Phases for v3

### Phase 1: v2 + Kubernetes Workers
- [ ] Helm chart for eve-horizon
- [ ] Workers as Deployments
- [ ] HPA for auto-scaling
- [ ] Local Kind setup

### Phase 2: App Deployment
- [ ] `clusters` and `environments` tables
- [ ] Deployment worker type
- [ ] `eve deploy` CLI commands
- [ ] RBAC setup for tenant namespaces

### Phase 3: DevOps Orchestrator
- [ ] DevOps orchestrator skill
- [ ] Pipeline patterns
- [ ] Canary/blue-green strategies
- [ ] Rollback automation

### Phase 4: Multi-Cluster
- [ ] Provider abstraction
- [ ] ECS support
- [ ] Multi-region deployments
- [ ] Cluster health monitoring

### Phase 5: Production Hardening
- [ ] Network policies
- [ ] Secret management (Vault/ESO)
- [ ] Audit logging
- [ ] Cost tracking

---

## Tech Stack Summary

| Component | v2 | v3 |
|-----------|----|----|
| Container Orchestration | Docker Compose | Kubernetes |
| Auto-scaling | Manual | HPA/KEDA |
| Auth | Supabase Auth | Supabase Auth |
| Database | Supabase PostgreSQL | Supabase PostgreSQL |
| Message Queue | PGMQ | PGMQ |
| Secrets | Env files | K8s Secrets + Vault |
| Networking | Docker network | K8s Network Policies |
| Local Dev | docker-compose | Kind + Tilt |
| Production | docker-compose | EKS/GKE/AKS |

---

*v3 - Kubernetes-native, production-ready platform*
