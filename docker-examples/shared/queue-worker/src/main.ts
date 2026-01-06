import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const workerCount = Number(process.env.WORKER_COUNT) || 1;

  console.log('=== mclaude Queue Worker ===');
  console.log(`Worker count: ${workerCount}`);
  console.log(`Poll interval: ${process.env.POLL_INTERVAL_MS || 5000}ms`);
  console.log(`Workspace base: ${process.env.WORKSPACE_BASE || '/workspace'}`);
  console.log('');

  const app = await NestFactory.createApplicationContext(
    AppModule.forWorkers(workerCount),
  );

  // Handle graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`\nReceived ${signal}, shutting down gracefully...`);
      await app.close();
      process.exit(0);
    });
  }

  console.log(`Started ${workerCount} parallel worker(s)`);
  console.log('Listening for orchestration requests...\n');
}

bootstrap().catch((err) => {
  console.error('Failed to start queue worker:', err);
  process.exit(1);
});
