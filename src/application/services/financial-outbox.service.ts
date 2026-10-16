import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransaction } from '../../domain/entities/wager-transaction.js';
import type { Wallet } from '../../domain/entities/wallet.js';
import type { Money } from '../../domain/value-objects/money.js';
import { MikroOrmOutboxRepository } from '../../infrastructure/persistence/repositories/mikro-orm-outbox.repository.js';

export class FinancialOutboxService {
  private readonly outbox: MikroOrmOutboxRepository;

  constructor(em: EntityManager) {
    this.outbox = new MikroOrmOutboxRepository(em);
  }

  async recordTransaction(
    transaction: WagerTransaction,
  ): Promise<void> {
    const eventType =
      transaction.status === 'PROCESSED'
        ? 'WagerTransactionProcessed'
        : transaction.status === 'REJECTED'
          ? 'WagerTransactionRejected'
          : transaction.status === 'PENDING_REFERENCE'
            ? 'WagerTransactionPendingReference'
            : null;

    if (!eventType) {
      throw new Error('UNSUPPORTED_OUTBOX_STATUS');
    }

    await this.outbox.save({
      eventType,
      aggregateType: 'WagerTransaction',
      aggregateId: transaction.id,
      payload: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId:
          transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        status: transaction.status,
        amount: transaction.money.toJSON().amount,
        currency: transaction.money.currency,
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId ?? null,
        referenceTransactionId:
          transaction.referenceTransactionId ?? null,
        failureCode: transaction.failureCode ?? null,
      },
    });
  }

  async recordBalanceChanged(
    wallet: Wallet,
    transaction: WagerTransaction,
    balanceBefore: Money,
    direction: 'DEBIT' | 'CREDIT',
  ): Promise<void> {
    await this.outbox.save({
      eventType: 'WalletBalanceChanged',
      aggregateType: 'Wallet',
      aggregateId: wallet.id,
      payload: {
        transactionId: transaction.id,
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balanceBefore: balanceBefore.toJSON().amount,
        balanceAfter: wallet.balance.toJSON().amount,
        direction,
        amount: transaction.money.toJSON().amount,
        walletVersion: wallet.version,
      },
    });
  }
}