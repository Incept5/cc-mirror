import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Request } from './request.entity';

export type ResultStatus = 'success' | 'error' | 'partial' | 'timeout';

export interface ResultOutput {
  stdout?: string;
  stderr?: string;
  [key: string]: unknown;
}

export interface ErrorDetails {
  code?: string;
  stack?: string;
  [key: string]: unknown;
}

@Entity('orchestration_results')
export class Result {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'request_id', type: 'uuid' })
  requestId!: string;

  @ManyToOne(() => Request, (request) => request.results, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request!: Request;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'text' })
  status!: ResultStatus;

  @Column({ type: 'jsonb', default: {} })
  output!: ResultOutput;

  @Column({ name: 'pr_url', type: 'text', nullable: true })
  prUrl?: string;

  @Column({ name: 'commit_sha', type: 'text', nullable: true })
  commitSha?: string;

  @Column({ name: 'branch_name', type: 'text', nullable: true })
  branchName?: string;

  @Column({ name: 'duration_ms', type: 'integer', nullable: true })
  durationMs?: number;

  @Column({ name: 'worker_id', type: 'text', nullable: true })
  workerId?: string;

  @Column({ type: 'text', nullable: true })
  error?: string;

  @Column({ name: 'error_details', type: 'jsonb', nullable: true })
  errorDetails?: ErrorDetails;
}
