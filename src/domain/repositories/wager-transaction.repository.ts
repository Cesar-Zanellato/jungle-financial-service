import type { WagerTransaction, WagerTransactionKind } from '../entities/wager-transaction.js';

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;

  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;

  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;

  findActiveReversal(
    referenceTransactionId: string,
    kind: 'REFUND' | 'ROLLBACK',
  ): Promise<WagerTransaction | null>;

  findPendingRefundsByReference(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<WagerTransaction[]>;

  findPendingRollbacksByReference(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<WagerTransaction[]>;

  findByIdForUpdate(
    id: string,
  ): Promise<WagerTransaction | null>;

  save(transaction: WagerTransaction): Promise<void>;
}