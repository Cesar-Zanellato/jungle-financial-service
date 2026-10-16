import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';

export type OutboxEventType =
  | 'WagerTransactionProcessed'
  | 'WagerTransactionRejected'
  | 'WalletBalanceChanged'
  | 'WagerTransactionPendingReference';

export interface CreateOutboxEventInput {
  eventType: OutboxEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export interface OutboxEvent {
  id: string;
  eventType: OutboxEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

export interface ClaimedOutboxEvent extends OutboxEvent {
  lockedBy: string;
  lockedUntil: Date;
}

export interface ClaimOutboxOptions {
  workerId: string;
  batchSize: number;
  leaseSeconds: number;
}

export class MikroOrmOutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async save(input: CreateOutboxEventInput): Promise<string> {
    const id = randomUUID();

    await this.em.execute(
      `
        INSERT INTO outbox_events (
          id,
          event_type,
          aggregate_type,
          aggregate_id,
          payload,
          status,
          attempts,
          max_attempts,
          available_at,
          created_at
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          CAST(? AS jsonb),
          'PENDING',
          0,
          10,
          NOW(),
          NOW()
        )
      `,
      [
        id,
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        JSON.stringify(input.payload),
      ],
    );

    return id;
  }

  async findById(id: string): Promise<OutboxEvent | null> {
    const rows = await this.em.execute<
      Array<{
        id: string;
        event_type: OutboxEventType;
        aggregate_type: string;
        aggregate_id: string;
        payload: Record<string, unknown> | string;
        status: OutboxEvent['status'];
        attempts: number;
        max_attempts: number;
        created_at: Date | string;
      }>
    >(
      `
        SELECT
          id,
          event_type,
          aggregate_type,
          aggregate_id,
          payload,
          status,
          attempts,
          max_attempts,
          created_at
        FROM outbox_events
        WHERE id = ?
      `,
      [id],
    );

    const row = rows[0];

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload:
        typeof row.payload === 'string'
          ? JSON.parse(row.payload)
          : row.payload,
      status: row.status,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      createdAt: new Date(row.created_at),
    };
  }
  
  async claimBatch(
    options: ClaimOutboxOptions,
  ): Promise<ClaimedOutboxEvent[]> {
    const { workerId, batchSize, leaseSeconds } = options;

    if (
      !workerId.trim() ||
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 100 ||
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 1
    ) {
      throw new Error('INVALID_OUTBOX_CLAIM_OPTIONS');
    }

    const rows = await this.em.execute<
      Array<{
        id: string;
        event_type: OutboxEventType;
        aggregate_type: string;
        aggregate_id: string;
        payload: Record<string, unknown> | string;
        status: 'PROCESSING';
        attempts: number;
        max_attempts: number;
        created_at: Date | string;
        locked_by: string;
        locked_until: Date | string;
      }>
    >(
      `
      WITH selected AS (
        SELECT id
        FROM outbox_events
        WHERE (
          (
            status = 'PENDING'
            AND available_at <= NOW()
          )
          OR (
            status = 'PROCESSING'
            AND locked_until <= NOW()
          )
        )
        AND attempts < max_attempts
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ?
      )
      UPDATE outbox_events AS events
      SET
        status = 'PROCESSING',
        attempts = attempts + 1,
        locked_by = ?,
        locked_until = NOW() + (? * INTERVAL '1 second'),
        last_error = NULL
      FROM selected
      WHERE events.id = selected.id
      RETURNING
        events.id,
        events.event_type,
        events.aggregate_type,
        events.aggregate_id,
        events.payload,
        events.status,
        events.attempts,
        events.max_attempts,
        events.created_at,
        events.locked_by,
        events.locked_until
      `,
      [batchSize, workerId, leaseSeconds],
    );

    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload:
        typeof row.payload === 'string'
          ? JSON.parse(row.payload)
          : row.payload,
      status: row.status,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      createdAt: new Date(row.created_at),
      lockedBy: row.locked_by,
      lockedUntil: new Date(row.locked_until),
    }));
  }
  
  async markPublished(
    eventId: string,
    workerId: string,
    expectedAttempts: number,
  ): Promise<boolean> {
    const rows = await this.em.execute<Array<{ id: string }>>(
      `
      UPDATE outbox_events
      SET
        status = 'PUBLISHED',
        published_at = NOW(),
        locked_by = NULL,
        locked_until = NULL,
        last_error = NULL
      WHERE id = ?
        AND status = 'PROCESSING'
        AND locked_by = ?
        AND attempts = ?
        AND locked_until > NOW()
      RETURNING id
      `,
      [eventId, workerId, expectedAttempts],
    );

    return rows.length === 1;
  }
  
  async markFailed(
    eventId: string,
    workerId: string,
    expectedAttempts: number,
    errorMessage: string,
  ): Promise<boolean> {
    const rows = await this.em.execute<Array<{ id: string }>>(
      `
      UPDATE outbox_events
      SET
        status = CASE
          WHEN attempts >= max_attempts
            THEN 'FAILED'
          ELSE 'PENDING'
        END,
        available_at = NOW() + (
          LEAST(
            300,
            POWER(2, LEAST(attempts, 8))::integer
          ) * INTERVAL '1 second'
        ),
        locked_by = NULL,
        locked_until = NULL,
        last_error = ?
      WHERE id = ?
        AND status = 'PROCESSING'
        AND locked_by = ?
        AND attempts = ?
        AND locked_until > NOW()
      RETURNING id
      `,
      [errorMessage.slice(0, 2000), eventId, workerId, expectedAttempts],
    );

    return rows.length === 1;
  }

  async recoverExpired(): Promise<{
    recovered: number;
    failed: number;
  }> {
    const rows = await this.em.execute<
      Array<{ status: 'PENDING' | 'FAILED' }>
    >(
      `
      UPDATE outbox_events
      SET
        status = CASE
          WHEN attempts >= max_attempts
            THEN 'FAILED'
          ELSE 'PENDING'
        END,
        available_at = NOW(),
        locked_by = NULL,
        locked_until = NULL,
        last_error = 'WORKER_LEASE_EXPIRED'
      WHERE status = 'PROCESSING'
        AND locked_until <= NOW()
      RETURNING status
      `,
    );

    return {
      recovered: rows.filter(
        (row) => row.status === 'PENDING',
      ).length,
      failed: rows.filter(
        (row) => row.status === 'FAILED',
      ).length,
    };
  }

}