#!/bin/bash
set -e

echo "=== mclaude Queue Worker Entrypoint ==="

# Setup authentication
/app/scripts/setup-auth.sh

# Setup git/SSH
/app/scripts/setup-git.sh

# Wait for database to be ready
if [ -n "$DATABASE_URL" ]; then
    echo "Waiting for database..."
    until node -e "
        const { Client } = require('pg');
        const client = new Client({ connectionString: process.env.DATABASE_URL });
        client.connect().then(() => { client.end(); process.exit(0); }).catch(() => process.exit(1));
    " 2>/dev/null; do
        echo "  Database not ready, retrying in 2s..."
        sleep 2
    done
    echo "Database is ready!"
fi

# Start the queue worker
echo "Starting queue worker with ${WORKER_COUNT:-1} parallel worker(s)..."
cd /app/queue-worker
exec node dist/main.js
