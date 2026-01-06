# eve-horizon Authentication Context Flow

> **Status**: Architecture Design
> **Focus**: How authentication context propagates from user request through worker execution

## Overview

eve-horizon is a multi-tenant platform where multiple organizations run AI orchestration workloads. Authentication context must flow seamlessly from the initial HTTP request through to the Claude process executing in a worker container.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   WHY THIS MATTERS                                              │
│                                                                 │
│   • Multi-tenancy: Org A must never see Org B's data           │
│   • Audit trail: Every action traceable to user + org          │
│   • RLS enforcement: Database policies need context            │
│   • Scoped permissions: Workers operate within boundaries      │
│   • Callbacks: Workers need tokens to talk back to API         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

The authentication flow uses **JWT tokens** issued by Supabase Auth, with custom claims for organization context. This document traces the complete journey of auth context from user to worker.

---

## The Auth Context Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      COMPLETE AUTH CONTEXT FLOW                                 │
│                                                                                 │
│   ┌──────────┐     ┌──────────┐     ┌──────────────────┐     ┌──────────────┐  │
│   │  User    │     │  Kong/   │     │  Control Plane   │     │  Supabase    │  │
│   │  (JWT)   │────▶│  API GW  │────▶│  API Server      │────▶│  Database    │  │
│   └──────────┘     └──────────┘     └──────────────────┘     └──────────────┘  │
│        │                │                    │                      │          │
│        │                │                    │                      │          │
│   JWT with:        Validates JWT       Extracts claims         Stores with    │
│   • sub (user_id)  Forwards headers    Inserts request         org_id +       │
│   • org_id                                                      user_id       │
│   • role                                                                       │
│                                                                                 │
│                                           │                                    │
│                                           ▼                                    │
│   ┌──────────────────────────────────────────────────────────────────────────┐ │
│   │                        orchestration_requests                            │ │
│   │                                                                          │ │
│   │  id: req-123                                                             │ │
│   │  org_id: org-456        ◀── From JWT claim                              │ │
│   │  user_id: user-789      ◀── From JWT sub claim                          │ │
│   │  worker_type: general                                                    │ │
│   │  prompt: "..."                                                           │ │
│   │  status: pending                                                         │ │
│   │                                                                          │ │
│   └──────────────────────────────────────────────────────────────────────────┘ │
│                                           │                                    │
│                                           │  Worker claims request             │
│                                           ▼                                    │
│   ┌──────────────────────────────────────────────────────────────────────────┐ │
│   │                           WORKER CONTAINER                               │ │
│   │                                                                          │ │
│   │  ┌────────────────────────────────────────────────────────────────────┐  │ │
│   │  │  Queue Worker (NestJS)                                             │  │ │
│   │  │                                                                    │  │ │
│   │  │  1. Claims request from queue                                      │  │ │
│   │  │  2. Reads org_id, user_id from row                                │  │ │
│   │  │  3. Generates scoped callback token                               │  │ │
│   │  │  4. Injects environment variables                                 │  │ │
│   │  │                                                                    │  │ │
│   │  └────────────────────────────────────────────────────────────────────┘  │ │
│   │                              │                                            │ │
│   │                              ▼                                            │ │
│   │  ┌────────────────────────────────────────────────────────────────────┐  │ │
│   │  │  mclaude Process                                                   │  │ │
│   │  │                                                                    │  │ │
│   │  │  Environment:                                                      │  │ │
│   │  │  • EVE_ORG_ID=org-456                                             │  │ │
│   │  │  • EVE_USER_ID=user-789                                           │  │ │
│   │  │  • EVE_REQUEST_ID=req-123                                         │  │ │
│   │  │  • EVE_CALLBACK_TOKEN=eyJ...                                      │  │ │
│   │  │                                                                    │  │ │
│   │  │  ┌──────────────────────────────────────────────────────────────┐ │  │ │
│   │  │  │  eve-cli commands                                            │ │  │ │
│   │  │  │                                                              │ │  │ │
│   │  │  │  getAuthContext() → reads env vars                          │ │  │ │
│   │  │  │  All DB queries include org_id                              │ │  │ │
│   │  │  │  API calls use callback token                               │ │  │ │
│   │  │  │                                                              │ │  │ │
│   │  │  └──────────────────────────────────────────────────────────────┘ │  │ │
│   │  └────────────────────────────────────────────────────────────────────┘  │ │
│   │                                                                          │ │
│   └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## JWT Claims Structure

Supabase Auth issues JWTs with standard claims. We extend these with custom claims for organization context.

### Standard Supabase JWT

```json
{
  "aud": "authenticated",
  "exp": 1704672000,
  "iat": 1704585600,
  "iss": "https://your-project.supabase.co/auth/v1",
  "sub": "user-789-uuid",
  "email": "alice@acme.com",
  "role": "authenticated",
  "app_metadata": {
    "provider": "email"
  },
  "user_metadata": {
    "name": "Alice"
  }
}
```

### Extended JWT with Organization Claims

```json
{
  "aud": "authenticated",
  "exp": 1704672000,
  "iat": 1704585600,
  "iss": "https://your-project.supabase.co/auth/v1",
  "sub": "user-789-uuid",
  "email": "alice@acme.com",
  "role": "authenticated",

  "org_id": "org-456-uuid",
  "org_role": "admin",
  "org_permissions": ["requests.create", "requests.read", "projects.manage"],

  "app_metadata": {
    "provider": "email",
    "organizations": [
      {"id": "org-456-uuid", "role": "admin"},
      {"id": "org-789-uuid", "role": "member"}
    ]
  }
}
```

### Setting Organization Claims

Organization claims are set when:

1. **User logs in and selects org** - Frontend calls org selection endpoint
2. **Token refresh** - Claims refreshed with current org context
3. **Org switch** - New token issued with different org_id

```sql
-- Function to set org claims on JWT (called during auth)
CREATE OR REPLACE FUNCTION auth.set_org_claims(user_id UUID, target_org_id UUID)
RETURNS VOID AS $$
DECLARE
    v_role TEXT;
BEGIN
    -- Verify user is member of org
    SELECT role INTO v_role
    FROM eve.org_members
    WHERE org_members.user_id = set_org_claims.user_id
      AND org_members.org_id = target_org_id;

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'User is not a member of this organization';
    END IF;

    -- Update user's app_metadata with current org
    UPDATE auth.users
    SET raw_app_meta_data = raw_app_meta_data || jsonb_build_object(
        'current_org_id', target_org_id,
        'current_org_role', v_role
    )
    WHERE id = user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## Control Plane - Extracting Context

The control plane API receives requests with JWT tokens and extracts the authentication context.

### Kong API Gateway Configuration

```yaml
# Kong validates JWT before forwarding to control plane
plugins:
  - name: jwt
    config:
      uri_param_names: []
      cookie_names: []
      header_names:
        - Authorization
      claims_to_verify:
        - exp
      key_claim_name: iss
      secret_is_base64: false
      run_on_preflight: true

  # Forward claims as headers
  - name: request-transformer
    config:
      add:
        headers:
          - "X-User-ID:$(jwt.sub)"
          - "X-Org-ID:$(jwt.org_id)"
          - "X-Org-Role:$(jwt.org_role)"
```

### NestJS API - Extracting Context

```typescript
// auth.guard.ts - Extract and validate auth context
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get('SUPABASE_JWT_SECRET'),
      });

      // Attach auth context to request
      request.auth = {
        userId: payload.sub,
        orgId: payload.org_id,
        orgRole: payload.org_role,
        permissions: payload.org_permissions || [],
      };

      // Validate org membership (defense in depth)
      if (!payload.org_id) {
        throw new UnauthorizedException('No organization selected');
      }

    } catch (error) {
      throw new UnauthorizedException('Invalid token');
    }

    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}

// auth-context.decorator.ts - Easy access to auth context
export const AuthContext = createParamDecorator(
  (data: keyof AuthContextType | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const auth = request.auth as AuthContextType;
    return data ? auth?.[data] : auth;
  },
);

// Usage in controller
@Controller('requests')
export class RequestsController {
  @Post()
  @UseGuards(AuthGuard)
  async createRequest(
    @AuthContext() auth: AuthContextType,
    @Body() dto: CreateRequestDto,
  ) {
    // auth.userId and auth.orgId available here
    return this.requestService.create(dto, auth);
  }
}
```

### Inserting Request with Auth Context

```typescript
// request.service.ts
@Injectable()
export class RequestService {
  constructor(
    @InjectRepository(OrchestrationRequest)
    private readonly requestRepo: Repository<OrchestrationRequest>,
  ) {}

  async create(dto: CreateRequestDto, auth: AuthContextType): Promise<OrchestrationRequest> {
    const request = this.requestRepo.create({
      orgId: auth.orgId,           // From JWT
      userId: auth.userId,          // From JWT
      workerType: dto.workerType,
      prompt: dto.prompt,
      repoUrl: dto.repoUrl,
      branch: dto.branch || 'main',
      context: dto.context || {},
      config: dto.config || {},
      status: 'pending',
    });

    return this.requestRepo.save(request);
  }
}
```

---

## Database Schema Changes

The orchestration_requests table must include org_id and user_id columns for proper isolation and audit.

### Schema Definition

```sql
-- Organizations table
CREATE TABLE eve.organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),
    name            TEXT NOT NULL,
    slug            TEXT UNIQUE NOT NULL,
    config          JSONB DEFAULT '{}',

    -- Billing/limits
    tier            TEXT DEFAULT 'free',
    monthly_limit   INTEGER DEFAULT 1000
);

-- Organization members
CREATE TABLE eve.org_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES eve.organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'member',  -- 'owner', 'admin', 'member'
    created_at      TIMESTAMPTZ DEFAULT now(),

    UNIQUE (org_id, user_id)
);

-- Orchestration requests with auth context
CREATE TABLE eve.orchestration_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),

    -- AUTH CONTEXT (required for multi-tenancy)
    org_id          UUID NOT NULL REFERENCES eve.organizations(id),
    user_id         UUID NOT NULL REFERENCES auth.users(id),

    -- Request details
    worker_type     TEXT NOT NULL REFERENCES eve.worker_types(id),
    prompt          TEXT NOT NULL,
    repo_url        TEXT,
    branch          TEXT DEFAULT 'main',
    context         JSONB DEFAULT '{}',
    config          JSONB DEFAULT '{}',

    -- Workflow (v2)
    blocked_by      UUID REFERENCES eve.orchestration_requests(id),
    reply_to        UUID,

    -- State
    status          TEXT DEFAULT 'pending',
    claimed_by      TEXT,
    claimed_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,

    -- Scheduling
    scheduled_for   TIMESTAMPTZ
);

-- Indexes for efficient queries
CREATE INDEX idx_requests_org_status ON eve.orchestration_requests(org_id, status);
CREATE INDEX idx_requests_user ON eve.orchestration_requests(user_id, created_at DESC);
CREATE INDEX idx_requests_pending ON eve.orchestration_requests(worker_type, status)
    WHERE status = 'pending';
```

### Row Level Security Policies

```sql
-- Enable RLS
ALTER TABLE eve.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE eve.org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE eve.orchestration_requests ENABLE ROW LEVEL SECURITY;

-- Organizations: Users see orgs they're members of
CREATE POLICY "org_member_access" ON eve.organizations
    FOR SELECT
    USING (
        id IN (
            SELECT org_id FROM eve.org_members
            WHERE user_id = auth.uid()
        )
    );

-- Org members: Users see members of their orgs
CREATE POLICY "org_members_access" ON eve.org_members
    FOR SELECT
    USING (
        org_id IN (
            SELECT org_id FROM eve.org_members
            WHERE user_id = auth.uid()
        )
    );

-- Requests: Users see requests from their orgs
CREATE POLICY "org_requests_select" ON eve.orchestration_requests
    FOR SELECT
    USING (
        org_id IN (
            SELECT org_id FROM eve.org_members
            WHERE user_id = auth.uid()
        )
    );

-- Requests: Users can only create requests for their current org
CREATE POLICY "org_requests_insert" ON eve.orchestration_requests
    FOR INSERT
    WITH CHECK (
        -- org_id must match a user's membership
        org_id IN (
            SELECT org_id FROM eve.org_members
            WHERE user_id = auth.uid()
        )
        -- user_id must be the current user
        AND user_id = auth.uid()
    );

-- Service role bypasses RLS for worker operations
-- Workers use service role key, not user tokens
```

---

## Worker - Injecting Environment Variables

The queue worker reads org_id and user_id from the claimed request and injects them as environment variables for the mclaude process.

### Queue Worker Implementation

```typescript
// queue.service.ts
@Injectable()
export class QueueService implements OnModuleInit {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(OrchestrationRequest)
    private readonly requestRepo: Repository<OrchestrationRequest>,
    private readonly tokenService: TokenService,
  ) {}

  async processRequest(request: OrchestrationRequest): Promise<void> {
    this.logger.log(`Processing request ${request.id} for org ${request.orgId}`);

    // Generate scoped callback token for this request
    const callbackToken = await this.tokenService.generateCallbackToken({
      requestId: request.id,
      orgId: request.orgId,
      userId: request.userId,
      expiresIn: '4h',  // Match max execution time
      permissions: ['request.update', 'request.complete'],
    });

    // Build environment variables for mclaude
    const env = this.buildProcessEnv(request, callbackToken);

    // Spawn mclaude with injected context
    await this.executeMclaude(request, env);
  }

  private buildProcessEnv(
    request: OrchestrationRequest,
    callbackToken: string,
  ): Record<string, string> {
    return {
      // Auth context
      EVE_ORG_ID: request.orgId,
      EVE_USER_ID: request.userId,
      EVE_REQUEST_ID: request.id,

      // Callback token for API access
      EVE_CALLBACK_TOKEN: callbackToken,
      EVE_API_URL: this.configService.get('CONTROL_PLANE_URL'),

      // Database connection (scoped by RLS)
      DATABASE_URL: this.configService.get('DATABASE_URL'),

      // Worker metadata
      EVE_WORKER_ID: this.configService.get('WORKER_ID'),
      EVE_WORKER_TYPE: request.workerType,

      // OpenTelemetry context
      OTEL_RESOURCE_ATTRIBUTES: [
        `eve.request_id=${request.id}`,
        `eve.org_id=${request.orgId}`,
        `eve.user_id=${request.userId}`,
        `eve.worker_type=${request.workerType}`,
      ].join(','),

      // Anthropic API key (from secrets)
      ANTHROPIC_API_KEY: this.configService.get('ANTHROPIC_API_KEY'),
    };
  }

  private async executeMclaude(
    request: OrchestrationRequest,
    env: Record<string, string>,
  ): Promise<void> {
    const workDir = await this.prepareWorkspace(request);

    // Build mclaude command
    const args = [
      '--print', 'text',
      '--allowedTools', this.getAllowedTools(request.workerType),
      '-p', request.prompt,
    ];

    // Add context if present
    if (request.context && Object.keys(request.context).length > 0) {
      args.push('--context', JSON.stringify(request.context));
    }

    return new Promise((resolve, reject) => {
      const process = spawn('mclaude', args, {
        cwd: workDir,
        env: { ...process.env, ...env },  // Merge with base env
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
        this.logger.debug(`[${request.id}] ${data}`);
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
        this.logger.warn(`[${request.id}] ${data}`);
      });

      process.on('close', async (code) => {
        if (code === 0) {
          await this.completeRequest(request.id, stdout);
          resolve();
        } else {
          await this.failRequest(request.id, stderr);
          reject(new Error(`mclaude exited with code ${code}`));
        }
      });
    });
  }
}
```

### Token Service for Callbacks

```typescript
// token.service.ts
@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async generateCallbackToken(params: {
    requestId: string;
    orgId: string;
    userId: string;
    expiresIn: string;
    permissions: string[];
  }): Promise<string> {
    const payload = {
      sub: params.userId,
      org_id: params.orgId,
      request_id: params.requestId,
      type: 'callback',
      permissions: params.permissions,
    };

    return this.jwtService.signAsync(payload, {
      secret: this.configService.get('CALLBACK_TOKEN_SECRET'),
      expiresIn: params.expiresIn,
    });
  }

  async verifyCallbackToken(token: string): Promise<CallbackTokenPayload> {
    return this.jwtService.verifyAsync(token, {
      secret: this.configService.get('CALLBACK_TOKEN_SECRET'),
    });
  }
}
```

---

## CLI Tools - Consuming Context

The eve-cli reads authentication context from environment variables set by the worker.

### Auth Context Module

```typescript
// eve-cli/src/auth/context.ts

export interface AuthContext {
  orgId: string;
  userId: string;
  requestId: string;
  callbackToken: string;
  apiUrl: string;
  workerId?: string;
  workerType?: string;
}

/**
 * Get authentication context from environment.
 * Throws if required variables are missing (not running in worker).
 */
export function getAuthContext(): AuthContext {
  const orgId = process.env.EVE_ORG_ID;
  const userId = process.env.EVE_USER_ID;
  const requestId = process.env.EVE_REQUEST_ID;
  const callbackToken = process.env.EVE_CALLBACK_TOKEN;
  const apiUrl = process.env.EVE_API_URL;

  // Validate required context
  if (!orgId || !userId || !requestId) {
    throw new Error(
      'Auth context not found. Eve CLI commands must run within a worker context.\n' +
      'Missing: ' + [
        !orgId && 'EVE_ORG_ID',
        !userId && 'EVE_USER_ID',
        !requestId && 'EVE_REQUEST_ID',
      ].filter(Boolean).join(', ')
    );
  }

  if (!callbackToken || !apiUrl) {
    throw new Error(
      'Callback credentials not found. Cannot communicate with control plane.\n' +
      'Missing: ' + [
        !callbackToken && 'EVE_CALLBACK_TOKEN',
        !apiUrl && 'EVE_API_URL',
      ].filter(Boolean).join(', ')
    );
  }

  return {
    orgId,
    userId,
    requestId,
    callbackToken,
    apiUrl,
    workerId: process.env.EVE_WORKER_ID,
    workerType: process.env.EVE_WORKER_TYPE,
  };
}

/**
 * Check if running in worker context (non-throwing version).
 */
export function isWorkerContext(): boolean {
  return Boolean(
    process.env.EVE_ORG_ID &&
    process.env.EVE_USER_ID &&
    process.env.EVE_REQUEST_ID
  );
}

/**
 * Get auth context or return undefined (for commands that work both ways).
 */
export function getAuthContextOrUndefined(): AuthContext | undefined {
  try {
    return getAuthContext();
  } catch {
    return undefined;
  }
}
```

### Using Context in CLI Commands

```typescript
// eve-cli/src/commands/request.ts

import { getAuthContext } from '../auth/context';
import { createApiClient } from '../api/client';

export async function createRequest(opts: CreateRequestOptions): Promise<void> {
  const auth = getAuthContext();
  const api = createApiClient(auth);

  const result = await api.post('/requests', {
    workerType: opts.workerType,
    prompt: opts.prompt,
    repoUrl: opts.repoUrl,
    context: {
      ...opts.context,
      parent_request_id: auth.requestId,  // Track lineage
    },
    blockedBy: opts.blockedBy,
    replyTo: opts.replyToOrchestrator ? auth.requestId : opts.replyTo,
  });

  console.log(JSON.stringify(result, null, 2));
}

// eve-cli/src/api/client.ts

export function createApiClient(auth: AuthContext) {
  return axios.create({
    baseURL: auth.apiUrl,
    headers: {
      Authorization: `Bearer ${auth.callbackToken}`,
      'X-Request-ID': auth.requestId,
      'X-Org-ID': auth.orgId,
    },
  });
}
```

### Database Access with Context

```typescript
// eve-cli/src/db/client.ts

import { getAuthContext } from '../auth/context';

/**
 * Execute query with RLS context set.
 * Workers use service role but we still set context for audit.
 */
export async function query<T>(
  sql: string,
  params: any[] = [],
): Promise<T[]> {
  const auth = getAuthContext();
  const client = await getPoolClient();

  try {
    // Set RLS context variables
    await client.query(
      `SELECT set_config('eve.current_org_id', $1, true),
              set_config('eve.current_user_id', $2, true),
              set_config('eve.current_request_id', $3, true)`,
      [auth.orgId, auth.userId, auth.requestId]
    );

    // Execute the actual query
    const result = await client.query(sql, params);
    return result.rows as T[];

  } finally {
    client.release();
  }
}
```

---

## RLS Enforcement

PostgreSQL Row Level Security uses the context set by workers to enforce tenant isolation.

### Setting Context for Queries

```sql
-- Function to get current org from session variable
CREATE OR REPLACE FUNCTION eve.current_org_id()
RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('eve.current_org_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to get current user from session variable
CREATE OR REPLACE FUNCTION eve.current_user_id()
RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('eve.current_user_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to get current request from session variable
CREATE OR REPLACE FUNCTION eve.current_request_id()
RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('eve.current_request_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE;
```

### RLS Policies Using Context

```sql
-- Results table: Workers can only write results for their org's requests
CREATE TABLE eve.orchestration_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL REFERENCES eve.orchestration_requests(id),
    org_id          UUID NOT NULL REFERENCES eve.organizations(id),

    output          TEXT,
    status          TEXT NOT NULL,
    metadata        JSONB DEFAULT '{}',

    created_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE eve.orchestration_results ENABLE ROW LEVEL SECURITY;

-- Read: Must be in same org
CREATE POLICY "results_select" ON eve.orchestration_results
    FOR SELECT
    USING (
        org_id = eve.current_org_id()
        OR org_id IN (
            SELECT org_id FROM eve.org_members
            WHERE user_id = auth.uid()
        )
    );

-- Insert: Must match current org context
CREATE POLICY "results_insert" ON eve.orchestration_results
    FOR INSERT
    WITH CHECK (
        org_id = eve.current_org_id()
    );

-- Projects table with RLS
CREATE TABLE eve.projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES eve.organizations(id),
    name            TEXT NOT NULL,
    config          JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now(),

    UNIQUE (org_id, name)
);

ALTER TABLE eve.projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "projects_isolation" ON eve.projects
    USING (org_id = eve.current_org_id());
```

### Worker Setting Context Before Queries

```typescript
// queue.service.ts - Set context before any DB operation

async setDatabaseContext(request: OrchestrationRequest): Promise<void> {
  await this.dataSource.query(`
    SELECT
      set_config('eve.current_org_id', $1, false),
      set_config('eve.current_user_id', $2, false),
      set_config('eve.current_request_id', $3, false)
  `, [request.orgId, request.userId, request.id]);
}

async processRequest(request: OrchestrationRequest): Promise<void> {
  // Set context at start of processing
  await this.setDatabaseContext(request);

  // All subsequent queries in this connection will use the context
  // ... process request
}
```

---

## Token Scoping for Callbacks

Workers need to call back to the control plane API to update status, create child requests, etc. These callbacks use scoped tokens with limited permissions.

### Callback Token Structure

```typescript
interface CallbackToken {
  // Standard JWT claims
  iat: number;          // Issued at
  exp: number;          // Expiration (short-lived, 4h max)

  // Identity
  sub: string;          // Original user ID
  org_id: string;       // Organization ID

  // Scope
  type: 'callback';     // Token type identifier
  request_id: string;   // Bound to specific request

  // Permissions (limited set)
  permissions: string[];
}

// Allowed permissions for callback tokens
const CALLBACK_PERMISSIONS = [
  'request.update',      // Update own request status
  'request.complete',    // Mark request complete
  'request.create',      // Create child requests (same org)
  'result.create',       // Write results
  'storage.write',       // Upload artifacts
] as const;
```

### Validating Callback Tokens

```typescript
// auth.guard.ts - Callback token validation

@Injectable()
export class CallbackAuthGuard implements CanActivate {
  constructor(private readonly tokenService: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No callback token provided');
    }

    try {
      const payload = await this.tokenService.verifyCallbackToken(token);

      // Verify token type
      if (payload.type !== 'callback') {
        throw new UnauthorizedException('Invalid token type');
      }

      // Verify token hasn't been revoked
      const isRevoked = await this.tokenService.isTokenRevoked(payload.request_id);
      if (isRevoked) {
        throw new UnauthorizedException('Token has been revoked');
      }

      // Attach validated context
      request.auth = {
        userId: payload.sub,
        orgId: payload.org_id,
        requestId: payload.request_id,
        permissions: payload.permissions,
        isCallback: true,
      };

      return true;

    } catch (error) {
      throw new UnauthorizedException('Invalid callback token');
    }
  }
}

// permission.guard.ts - Check specific permissions

@Injectable()
export class RequirePermission implements CanActivate {
  constructor(private readonly requiredPermission: string) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const auth = request.auth;

    if (!auth?.permissions?.includes(this.requiredPermission)) {
      throw new ForbiddenException(
        `Missing required permission: ${this.requiredPermission}`
      );
    }

    return true;
  }
}

// Usage in controller
@Controller('requests')
export class RequestsController {
  @Patch(':id/status')
  @UseGuards(CallbackAuthGuard, new RequirePermission('request.update'))
  async updateStatus(
    @Param('id') id: string,
    @AuthContext() auth: AuthContextType,
    @Body() dto: UpdateStatusDto,
  ) {
    // Verify the request being updated matches the token's request_id
    if (auth.isCallback && auth.requestId !== id) {
      throw new ForbiddenException('Can only update own request');
    }

    return this.requestService.updateStatus(id, dto);
  }
}
```

### Token Revocation

```sql
-- Track revoked callback tokens
CREATE TABLE eve.revoked_tokens (
    request_id      UUID PRIMARY KEY,
    revoked_at      TIMESTAMPTZ DEFAULT now(),
    reason          TEXT
);

-- Revoke token when request completes abnormally
CREATE OR REPLACE FUNCTION eve.revoke_request_token()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('failed', 'cancelled', 'timeout') THEN
        INSERT INTO eve.revoked_tokens (request_id, reason)
        VALUES (NEW.id, NEW.status)
        ON CONFLICT (request_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER revoke_token_on_failure
    AFTER UPDATE OF status ON eve.orchestration_requests
    FOR EACH ROW
    EXECUTE FUNCTION eve.revoke_request_token();
```

---

## Security Considerations

```
┌─────────────────────────────────────────────────────────────────┐
│                    SECURITY CHECKLIST                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  TOKEN VALIDATION                                               │
│  ─────────────────                                              │
│  ✓ Kong validates JWT signature before forwarding               │
│  ✓ Control plane re-validates with Supabase secret             │
│  ✓ Callback tokens use separate signing key                    │
│  ✓ All tokens have expiration (max 4h for callbacks)           │
│  ✓ Token revocation on request failure                         │
│                                                                 │
│  TENANT ISOLATION                                               │
│  ─────────────────                                              │
│  ✓ org_id stored in every request/result row                   │
│  ✓ RLS policies enforce org boundaries                         │
│  ✓ Workers set context before all DB operations                │
│  ✓ API validates org membership on every request               │
│  ✓ Callback tokens scoped to specific request                  │
│                                                                 │
│  AUDIT LOGGING                                                  │
│  ─────────────────                                              │
│  ✓ user_id tracked on all requests                             │
│  ✓ request_id propagates through child requests                │
│  ✓ All API calls logged with auth context                      │
│  ✓ Token usage logged (creation, verification, revocation)     │
│                                                                 │
│  DEFENSE IN DEPTH                                               │
│  ─────────────────                                              │
│  ✓ Multiple validation layers (Kong → API → DB)                │
│  ✓ RLS as final enforcement (even if code has bugs)            │
│  ✓ Separate signing keys for different token types             │
│  ✓ Short-lived callback tokens                                 │
│  ✓ Principle of least privilege for callback permissions       │
│                                                                 │
│  SECRETS MANAGEMENT                                             │
│  ─────────────────                                              │
│  ✓ JWT secrets in environment/secrets manager                  │
│  ✓ Database credentials not exposed to mclaude process         │
│  ✓ API keys injected at runtime, not in images                 │
│  ✓ Callback tokens don't contain sensitive data                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Audit Log Schema

```sql
CREATE TABLE eve.auth_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),

    -- Who
    org_id          UUID,
    user_id         UUID,
    request_id      UUID,

    -- What
    action          TEXT NOT NULL,
    resource_type   TEXT,
    resource_id     UUID,

    -- Details
    details         JSONB,
    ip_address      INET,
    user_agent      TEXT,

    -- Token info
    token_type      TEXT,  -- 'user', 'callback', 'service'
    token_id        TEXT   -- JTI for tracking
);

CREATE INDEX idx_audit_org ON eve.auth_audit_log(org_id, created_at DESC);
CREATE INDEX idx_audit_request ON eve.auth_audit_log(request_id);
```

### Logging Authentication Events

```typescript
// auth-audit.service.ts

@Injectable()
export class AuthAuditService {
  constructor(
    @InjectRepository(AuthAuditLog)
    private readonly auditRepo: Repository<AuthAuditLog>,
  ) {}

  async log(event: {
    action: string;
    orgId?: string;
    userId?: string;
    requestId?: string;
    resourceType?: string;
    resourceId?: string;
    details?: Record<string, any>;
    request?: Request;
    tokenType?: string;
  }): Promise<void> {
    await this.auditRepo.insert({
      action: event.action,
      orgId: event.orgId,
      userId: event.userId,
      requestId: event.requestId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      details: event.details,
      ipAddress: event.request?.ip,
      userAgent: event.request?.headers['user-agent'],
      tokenType: event.tokenType,
    });
  }
}

// Usage
await this.auditService.log({
  action: 'request.created',
  orgId: auth.orgId,
  userId: auth.userId,
  resourceType: 'request',
  resourceId: newRequest.id,
  details: { workerType: dto.workerType },
  request: httpRequest,
  tokenType: 'user',
});
```

---

## Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   THE AUTH FLOW AT A GLANCE                                     │
│                                                                 │
│   1. USER AUTHENTICATES                                         │
│      Supabase Auth issues JWT with sub (user_id)               │
│      User selects org, JWT gets org_id claim                   │
│                                                                 │
│   2. API RECEIVES REQUEST                                       │
│      Kong validates JWT, forwards to control plane             │
│      API extracts org_id + user_id from claims                 │
│      Request stored with auth context columns                  │
│                                                                 │
│   3. WORKER CLAIMS REQUEST                                      │
│      Reads org_id + user_id from database row                  │
│      Generates scoped callback token                           │
│      Injects EVE_* environment variables                       │
│                                                                 │
│   4. CLAUDE PROCESS RUNS                                        │
│      eve-cli reads context from environment                    │
│      All DB queries include org context                        │
│      API calls use callback token                              │
│                                                                 │
│   5. RLS ENFORCES ISOLATION                                     │
│      Database policies check eve.current_org_id()              │
│      Even buggy code can't access other tenants                │
│                                                                 │
│   RESULT: Complete auth context from user → worker → DB        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## References

- [Supabase Auth Documentation](https://supabase.com/docs/guides/auth)
- [Supabase Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)
- [JWT Best Practices](https://datatracker.ietf.org/doc/html/rfc8725)
- [eve-horizon-v2.md](./eve-horizon-v2.md) - Core orchestration architecture
- [eve-horizon-observability.md](./eve-horizon-observability.md) - Monitoring and audit

---

*Authentication: The invisible thread that connects trust from user to execution.*
