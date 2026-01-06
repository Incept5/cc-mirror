-- Orchestration Queue Database Schema
-- PostgreSQL 16+

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Input queue: orchestration requests
CREATE TABLE orchestration_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Request status lifecycle: pending -> processing -> completed/failed
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),

    -- Repository configuration (optional - if provided, repo is cloned)
    repo_url        TEXT,                    -- Optional: git@github.com:org/repo.git or https://...
    branch          TEXT DEFAULT 'main',     -- Branch to clone (if repo_url provided)

    -- The actual task
    prompt          TEXT NOT NULL,           -- What mclaude should do

    -- Additional configuration (model overrides, skill settings, etc.)
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Request-specific metadata (credentials, URLs, etc.) - injected as env vars
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Worker claiming
    claimed_at      TIMESTAMPTZ,
    claimed_by      TEXT,                    -- Worker ID that claimed this request

    -- Retry handling
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    last_error      TEXT
);

-- Output table: orchestration results
CREATE TABLE orchestration_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL REFERENCES orchestration_requests(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Result status
    status          TEXT NOT NULL CHECK (status IN ('success', 'error', 'partial', 'timeout')),

    -- Output data
    output          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- Full mclaude response/output

    -- Git artifacts (if any were created)
    pr_url          TEXT,                    -- Pull request URL if created
    commit_sha      TEXT,                    -- Latest commit SHA if commits were made
    branch_name     TEXT,                    -- Branch name if a new branch was created

    -- Execution metadata
    duration_ms     INTEGER,                 -- How long mclaude took
    worker_id       TEXT,                    -- Which worker processed this

    -- Error details (if status = 'error')
    error           TEXT,
    error_details   JSONB
);

-- Indexes for efficient queue operations

-- Fast lookup of pending requests (the main queue query)
CREATE INDEX idx_requests_pending
    ON orchestration_requests(created_at)
    WHERE status = 'pending';

-- Find requests by status
CREATE INDEX idx_requests_status ON orchestration_requests(status);

-- Find requests claimed by a specific worker
CREATE INDEX idx_requests_claimed_by ON orchestration_requests(claimed_by)
    WHERE claimed_by IS NOT NULL;

-- Find stale processing requests (for recovery)
CREATE INDEX idx_requests_stale
    ON orchestration_requests(claimed_at)
    WHERE status = 'processing';

-- Results by request
CREATE INDEX idx_results_request ON orchestration_results(request_id);

-- Results by status for monitoring
CREATE INDEX idx_results_status ON orchestration_results(status, created_at);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for auto-updating updated_at
CREATE TRIGGER update_requests_updated_at
    BEFORE UPDATE ON orchestration_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to atomically claim a pending request
-- Returns the claimed request or NULL if none available
CREATE OR REPLACE FUNCTION claim_next_request(worker_id TEXT)
RETURNS orchestration_requests AS $$
DECLARE
    claimed orchestration_requests;
BEGIN
    UPDATE orchestration_requests
    SET
        status = 'processing',
        claimed_at = now(),
        claimed_by = worker_id,
        attempts = attempts + 1
    WHERE id = (
        SELECT id
        FROM orchestration_requests
        WHERE status = 'pending'
          AND attempts < max_attempts
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING * INTO claimed;

    RETURN claimed;
END;
$$ LANGUAGE plpgsql;

-- Function to release a stale request back to pending
-- Use for recovery when a worker dies mid-processing
CREATE OR REPLACE FUNCTION release_stale_requests(stale_threshold INTERVAL DEFAULT '30 minutes')
RETURNS INTEGER AS $$
DECLARE
    released_count INTEGER;
BEGIN
    UPDATE orchestration_requests
    SET
        status = 'pending',
        claimed_at = NULL,
        claimed_by = NULL
    WHERE status = 'processing'
      AND claimed_at < now() - stale_threshold
      AND attempts < max_attempts;

    GET DIAGNOSTICS released_count = ROW_COUNT;
    RETURN released_count;
END;
$$ LANGUAGE plpgsql;

-- Sample data for testing (commented out for production)
/*
INSERT INTO orchestration_requests (repo_url, branch, prompt, config) VALUES
(
    'git@github.com:example/test-repo.git',
    'main',
    'Review the code in src/ and create a PR with any improvements',
    '{"model": "sonnet", "timeout_minutes": 15}'::jsonb
);
*/
