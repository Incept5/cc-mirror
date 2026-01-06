import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Result } from './result.entity';

export type RequestStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface RequestConfig {
  model?: 'haiku' | 'sonnet' | 'opus';
  timeout_minutes?: number;
  skill_overrides?: Record<string, unknown>;
  [key: string]: unknown;
}

// Metadata is injected as environment variables to mclaude process
// Keys are converted to SCREAMING_SNAKE_CASE (e.g., supabaseUrl -> SUPABASE_URL)
export interface RequestMetadata {
  [key: string]: string | number | boolean;
}

@Entity('orchestration_requests')
export class Request {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  // eve-horizon multi-tenancy: organization and user ownership
  @Column({ name: 'org_id', type: 'text', nullable: true })
  orgId!: string | null;

  @Column({ name: 'user_id', type: 'text', nullable: true })
  userId!: string | null;

  @Column({
    type: 'text',
    default: 'pending',
  })
  status!: RequestStatus;

  @Column({ name: 'repo_url', type: 'text', nullable: true })
  repoUrl?: string;

  @Column({ type: 'text', default: 'main', nullable: true })
  branch?: string;

  @Column({ type: 'text' })
  prompt!: string;

  @Column({ type: 'jsonb', default: {} })
  config!: RequestConfig;

  @Column({ type: 'jsonb', default: {} })
  metadata!: RequestMetadata;

  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimedAt?: Date;

  @Column({ name: 'claimed_by', type: 'text', nullable: true })
  claimedBy?: string;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'max_attempts', type: 'integer', default: 3 })
  maxAttempts!: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string;

  @OneToMany(() => Result, (result) => result.request)
  results!: Result[];
}
