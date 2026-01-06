import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { MclaudeModule } from './mclaude/mclaude.module';
import { WorkspaceModule } from './workspace/workspace.module';
import configuration from './config/configuration';

@Module({})
export class AppModule {
  static forWorkers(workerCount: number): DynamicModule {
    // Create providers for each worker index
    const workerProviders = Array.from({ length: workerCount }, (_, i) => ({
      provide: `WORKER_${i}`,
      useValue: i,
    }));

    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
        }),
        ScheduleModule.forRoot(),
        DatabaseModule,
        MclaudeModule,
        WorkspaceModule,
        QueueModule.forWorkers(workerCount),
      ],
      providers: workerProviders,
    };
  }
}
