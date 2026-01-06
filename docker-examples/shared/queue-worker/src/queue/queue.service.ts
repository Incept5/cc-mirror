import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Request, RequestStatus } from '../database/entities/request.entity';
import { Result, ResultStatus, ResultOutput, ErrorDetails } from '../database/entities/result.entity';

export interface WriteResultParams {
  requestId: string;
  status: ResultStatus;
  output: ResultOutput;
  prUrl?: string;
  commitSha?: string;
  branchName?: string;
  durationMs?: number;
  workerId?: string;
  error?: string;
  errorDetails?: ErrorDetails;
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectRepository(Request)
    private readonly requestRepo: Repository<Request>,
    @InjectRepository(Result)
    private readonly resultRepo: Repository<Result>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Atomically claim the next pending request using PostgreSQL function
   */
  async claimNext(workerId: string): Promise<Request | null> {
    try {
      // Use the PostgreSQL function for atomic claim
      const result = await this.dataSource.query(
        'SELECT * FROM claim_next_request($1)',
        [workerId],
      );

      if (result && result.length > 0 && result[0].id) {
        const request = this.requestRepo.create(result[0]);
        this.logger.log(`Worker ${workerId} claimed request ${request.id}`);
        return request;
      }

      return null;
    } catch (error) {
      this.logger.error(`Failed to claim request: ${error}`);
      return null;
    }
  }

  /**
   * Write a result and update the request status
   */
  async writeResult(params: WriteResultParams): Promise<Result> {
    const {
      requestId,
      status,
      output,
      prUrl,
      commitSha,
      branchName,
      durationMs,
      workerId,
      error,
      errorDetails,
    } = params;

    // Create the result
    const result = this.resultRepo.create({
      requestId,
      status,
      output,
      prUrl,
      commitSha,
      branchName,
      durationMs,
      workerId,
      error,
      errorDetails,
    });

    await this.resultRepo.save(result);

    // Update request status based on result
    const requestStatus: RequestStatus = status === 'success' ? 'completed' : 'failed';
    await this.requestRepo.update(requestId, {
      status: requestStatus,
      lastError: error,
    });

    this.logger.log(
      `Result written for request ${requestId}: ${status}` +
        (durationMs ? ` (${durationMs}ms)` : ''),
    );

    return result;
  }

  /**
   * Release stale requests back to pending (for recovery)
   */
  async releaseStaleRequests(thresholdMinutes: number = 30): Promise<number> {
    const result = await this.dataSource.query(
      'SELECT release_stale_requests($1::interval)',
      [`${thresholdMinutes} minutes`],
    );

    const released = result?.[0]?.release_stale_requests || 0;
    if (released > 0) {
      this.logger.warn(`Released ${released} stale request(s)`);
    }
    return released;
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  }> {
    const stats = await this.requestRepo
      .createQueryBuilder('r')
      .select('r.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('r.status')
      .getRawMany();

    return stats.reduce(
      (acc, row) => {
        acc[row.status as keyof typeof acc] = parseInt(row.count, 10);
        return acc;
      },
      { pending: 0, processing: 0, completed: 0, failed: 0 },
    );
  }
}
