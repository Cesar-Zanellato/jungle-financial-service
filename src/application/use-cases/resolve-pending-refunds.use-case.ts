import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.js';
import { MikroOrmWalletRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';
import { FinancialOutboxService } from '../services/financial-outbox.service.js';

export interface ResolvePendingRefundsInput {
  providerId: string;
  referenceExternalTransactionId: string;
}

export interface ResolvePendingRefundsResult {
  processed: number;
  rejected: number;
  skipped: number;
}

export class ResolvePendingRefundsUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(
    input: ResolvePendingRefundsInput,
  ): Promise<ResolvePendingRefundsResult> {
    const repository = new MikroOrmWagerTransactionRepository(
      this.em.fork(),
    );

    const pendingRefunds =
      await repository.findPendingRefundsByReference(
        input.providerId,
        input.referenceExternalTransactionId,
      );

    const result: ResolvePendingRefundsResult = {
      processed: 0,
      rejected: 0,
      skipped: 0,
    };

    for (const pending of pendingRefunds) {
      const outcome = await this.resolveOne(pending.id);

      result[outcome]++;
    }

    return result;
  }

  private async resolveOne(
    refundId: string,
  ): Promise<'processed' | 'rejected' | 'skipped'> {
    // Descobrimos a carteira antes de iniciar a transação.
    // A leitura é apenas para obter o identificador.
    const lookupRepository = new MikroOrmWagerTransactionRepository(this.em.fork());

    const lookup = await lookupRepository.findById(refundId);

    if (!lookup) {
      return 'skipped';
    }

    return this.em.transactional(async (transactionalEm) => {
      const wallets = new MikroOrmWalletRepository(
        transactionalEm,
      );

      const transactions = new MikroOrmWagerTransactionRepository(transactionalEm);

      const ledger = new MikroOrmWalletLedgerRepository(
        transactionalEm,
      );

      const outbox = new FinancialOutboxService(transactionalEm);

      // Mantemos a mesma ordem de bloqueio do
      // ProcessRefundUseCase: carteira primeiro.
      const wallet = await wallets.findByIdForUpdate(
        lookup.walletId,
      );

      if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
      }

      // Bloqueamos o REFUND e verificamos seu estado atual.
      const refund = await transactions.findByIdForUpdate(
        refundId,
      );

      if (!refund || refund.status !== 'PENDING_REFERENCE') {
        return 'skipped';
      }

      const referenceExternalId =
        refund.referenceExternalTransactionId;

      if (!referenceExternalId) {
        refund.reject('REFERENCE_REQUIRED');
        await transactions.save(refund);
        await outbox.recordTransaction(refund);
        return 'rejected';
      }

      const original =
        await transactions.findByProviderAndExternalId(
          refund.providerId,
          referenceExternalId,
        );

      // A BET ainda não chegou.
      if (!original) {
        return 'skipped';
      }

      if (
        original.kind !== 'BET' ||
        original.status !== 'PROCESSED'
      ) {
        refund.reject('INVALID_REFUND_REFERENCE');
        await transactions.save(refund);
        await outbox.recordTransaction(refund);
        return 'rejected';
      }

      const sameReference =
        original.providerId === refund.providerId &&
        original.walletId === refund.walletId &&
        original.playerId === refund.playerId &&
        original.roundId === refund.roundId &&
        original.money.currency === refund.money.currency &&
        original.money.toJSON().amount ===
          refund.money.toJSON().amount;

      if (!sameReference) {
        refund.reject('REFUND_REFERENCE_MISMATCH');
        await transactions.save(refund);
        await outbox.recordTransaction(refund);
        return 'rejected';
      }

      // Outro REFUND já pode ter estornado essa BET.
      const existingRefund =
        await transactions.findActiveReversal(
          original.id,
          'REFUND',
        );

      if (existingRefund && existingRefund.id !== refund.id) {
        refund.reject('REFUND_ALREADY_EXISTS');
        await transactions.save(refund);
        await outbox.recordTransaction(refund);
        return 'rejected';
      }
  
      const existingRollback =
        await transactions.findActiveReversal(
          original.id,
          'ROLLBACK',
        );

      if (existingRollback) {
        refund.reject('BET_ALREADY_ROLLED_BACK');

        await transactions.save(refund);
        await outbox.recordTransaction(refund);

        return 'rejected';
      }

      const balanceBefore = wallet.balance;

      wallet.credit(refund.money);

      const balanceAfter = wallet.balance;

      refund.setReferenceTransactionId(original.id);

      const ledgerEntry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: refund.id,
        direction: 'CREDIT',
        money: refund.money,
        balanceBefore,
        balanceAfter,
        createdAt: new Date(),
      });

      
      refund.markProcessed();

      await wallets.save(wallet);
      await transactions.save(refund);
      await ledger.save(ledgerEntry);

      // Registra a conclusão do REFUND pendente.
      await outbox.recordTransaction(refund);

      // Registra o crédito realizado na carteira.
      await outbox.recordBalanceChanged(
        wallet,
        refund,
        balanceBefore,
        'CREDIT',
      );

      return 'processed';
    });
  }
}