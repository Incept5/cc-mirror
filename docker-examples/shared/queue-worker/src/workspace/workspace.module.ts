import { Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';

@Module({
  providers: [
    WorkspaceService,
    {
      provide: 'WORKSPACE_SERVICE',
      useExisting: WorkspaceService,
    },
  ],
  exports: [WorkspaceService, 'WORKSPACE_SERVICE'],
})
export class WorkspaceModule {}
