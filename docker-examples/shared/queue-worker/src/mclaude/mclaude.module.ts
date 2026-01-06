import { Module } from '@nestjs/common';
import { MclaudeService } from './mclaude.service';

@Module({
  providers: [
    MclaudeService,
    {
      provide: 'MCLAUDE_SERVICE',
      useExisting: MclaudeService,
    },
  ],
  exports: [MclaudeService, 'MCLAUDE_SERVICE'],
})
export class MclaudeModule {}
