import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { MikroOrmOutboxRepository } from '../../infrastructure/persistence/repositories/mikro-orm-outbox.repository.js';
import type { OutboxEventPublisher } from '../ports/outbox-event-publisher.js';

export interface OutboxWorkerOptions {
  batchSize?: number;
  leaseSeconds?: number;
  workerId?: string;
}

export interface OutboxWorkerResult {
  claimed: number;
  published: number;
  failed: number;
}

export class OutboxWorkerService {
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseSeconds: number;

  constructor(
    private readonly em: EntityManager,
    private readonly publisher: OutboxEventPublisher,
    options: OutboxWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? randomUUID();
    this.batchSize = options.batchSize ?? 20;
    this.leaseSeconds = options.leaseSeconds ?? 60;
  }

  async runOnce(): Promise<OutboxWorkerResult> {
    const repository = new MikroOrmOutboxRepository(
      this.em.fork(),
    );

    // Recupera eventos de workers interrompidos.
    await repository.recoverExpired();

    // Assume um lote em uma transação curta.
    const events = await this.em.fork().transactional(
      async (transactionalEm) => {
        const outbox = new MikroOrmOutboxRepository(
          transactionalEm,
        );

        return outbox.claimBatch({
          workerId: this.workerId,
          batchSize: this.batchSize,
          leaseSeconds: this.leaseSeconds,
        });
      },
    );

    const result: OutboxWorkerResult = {
      claimed: events.length,
      published: 0,
      failed: 0,
    };

    // Nenhum bloqueio SQL permanece aberto durante
    // a publicação dos eventos.
    for (const event of events) {
      try {
        await this.publisher.publish(event);

        const updated = await repository.markPublished(
          event.id,
          this.workerId,
          event.attempts,
        );

        if (updated) {
          result.published++;
        } else {
          result.failed++;
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        await repository.markFailed(
          event.id,
          this.workerId,
          event.attempts,
          message,
        );

        result.failed++;
      }
    }

    return result;
  }
}