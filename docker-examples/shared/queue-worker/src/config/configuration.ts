export default () => ({
  // Database
  database: {
    url: process.env.DATABASE_URL || 'postgres://user:pass@localhost:5432/orchestration',
  },

  // Worker configuration
  worker: {
    count: parseInt(process.env.WORKER_COUNT || '1', 10),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
    idPrefix: process.env.WORKER_ID_PREFIX || 'worker',
    staleThresholdMinutes: parseInt(process.env.STALE_THRESHOLD_MINUTES || '30', 10),
  },

  // mclaude configuration
  mclaude: {
    variant: process.env.MCLAUDE_VARIANT || 'mc',
    timeoutMs: parseInt(process.env.MCLAUDE_TIMEOUT_MS || '1800000', 10), // 30 min default
  },

  // Workspace configuration
  workspace: {
    base: process.env.WORKSPACE_BASE || '/workspace',
    cleanupAfterComplete: process.env.CLEANUP_AFTER_COMPLETE !== 'false',
  },
});
