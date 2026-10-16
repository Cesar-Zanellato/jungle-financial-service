import type { EntityManager } from '@mikro-orm/postgresql';
import { MikroOrmWagerTransactionRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { ResolvePendingRefundsUseCase } from '../use-cases/resolve-pending-refunds.use-case.js';
import { ResolvePendingRollbacksUseCase } from '../use-cases/resolve-pending-rollbacks.use-case.js';

export interface PendingReferenceRecoveryResult {
  referencesFound: number;
  processed: number;
  rejected: number;
  skipped: number;
  failed: number;
}

export class PendingReferenceRecoveryService {
  constructor(private readonly em: EntityManager) {}

  async runOnce(
      batchSize = 50,
      providerId?: string,
    ): Promise<PendingReferenceRecoveryResult> {
      const repository = new MikroOrmWagerTransactionRepository(
        this.em.fork(),
      );

      const references =
        await repository.findResolvablePendingReferences(
          batchSize,
          providerId,
        );

    const result: PendingReferenceRecoveryResult = {
      referencesFound: references.length,
      processed: 0,
      rejected: 0,
      skipped: 0,
      failed: 0,
    };

    for (const reference of references) {
      try {
        const refunds = new ResolvePendingRefundsUseCase(
          this.em.fork(),
        );

        const refundResult = await refunds.execute({
          providerId: reference.providerId,
          referenceExternalTransactionId:
            reference.referenceExternalTransactionId,
        });

        result.processed += refundResult.processed;
        result.rejected += refundResult.rejected;
        result.skipped += refundResult.skipped;

        const rollbacks = new ResolvePendingRollbacksUseCase(
          this.em.fork(),
        );

        const rollbackResult = await rollbacks.execute({
          providerId: reference.providerId,
          referenceExternalTransactionId:
            reference.referenceExternalTransactionId,
        });

        result.processed += rollbackResult.processed;
        result.rejected += rollbackResult.rejected;
        result.skipped += rollbackResult.skipped;
      } catch (error) {
        result.failed++;

        console.error(
          'Pending reference recovery failed:',
          reference,
          error,
        );
      }
    }

    return result;
  }
}