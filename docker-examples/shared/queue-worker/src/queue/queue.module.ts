import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Request } from '../database/entities/request.entity';
import { Result } from '../database/entities/result.entity';
import { QueueService } from './queue.service';
import { RequestProcessor } from './request.processor';
import { MclaudeModule } from '../mclaude/mclaude.module';
import { WorkspaceModule } from '../workspace/workspace.module';

@Module({})
export class QueueModule {
  static forWorkers(workerCount: number): DynamicModule {
    // Create a RequestProcessor provider for each worker
    const processorProviders = Array.from({ length: workerCount }, (_, i) => ({
      provide: `REQUEST_PROCESSOR_${i}`,
      useFactory: (
        queue: QueueService,
        mclaude: any, // MclaudeService
        workspace: any, // WorkspaceService
        config: ConfigService,
      ) => new RequestProcessor(queue, mclaude, workspace, config, i),
      inject: [
        QueueService,
        'MCLAUDE_SERVICE',
        'WORKSPACE_SERVICE',
        ConfigService,
      ],
    }));

    return {
      module: QueueModule,
      imports: [
        TypeOrmModule.forFeature([Request, Result]),
        MclaudeModule,
        WorkspaceModule,
      ],
      providers: [QueueService, ...processorProviders],
      exports: [QueueService],
    };
  }
}
