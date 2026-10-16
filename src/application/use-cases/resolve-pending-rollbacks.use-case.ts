import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.js';
import { MikroOrmWalletRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';
import { FinancialOutboxService } from '../services/financial-outbox.service.js';

export interface ResolvePendingRollbacksInput {
  providerId: string;
  referenceExternalTransactionId: string;
}

export interface ResolvePendingRollbacksResult {
  processed: number;
  rejected: number;
  skipped: number;
}

type ResolutionOutcome = 'processed' | 'rejected' | 'skipped';

export class ResolvePendingRollbacksUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(
    input: ResolvePendingRollbacksInput,
  ): Promise<ResolvePendingRollbacksResult> {
    const repository = new MikroOrmWagerTransactionRepository(
      this.em.fork(),
    );

    const pendingRollbacks =
      await repository.findPendingRollbacksByReference(
        input.providerId,
        input.referenceExternalTransactionId,
      );

    const result: ResolvePendingRollbacksResult = {
      processed: 0,
      rejected: 0,
      skipped: 0,
    };

    for (const pending of pendingRollbacks) {
      const outcome = await this.resolveOne(pending.id);
      result[outcome]++;
    }

    return result;
  }

  private async resolveOne(
    rollbackId: string,
  ): Promise<ResolutionOutcome> {
    // Consulta inicial apenas para identificar a carteira.
    const lookupRepository =
      new MikroOrmWagerTransactionRepository(this.em.fork());

    const lookup = await lookupRepository.findById(rollbackId);

    if (!lookup) {
      return 'skipped';
    }

    return this.em.transactional(async (transactionalEm) => {
      const wallets = new MikroOrmWalletRepository(
        transactionalEm,
      );

      const transactions =
        new MikroOrmWagerTransactionRepository(
          transactionalEm,
        );

      const ledger = new MikroOrmWalletLedgerRepository(
        transactionalEm,
      );

      const outbox = new FinancialOutboxService(
        transactionalEm,
      );

      // Mantém a ordem de bloqueio: carteira primeiro.
      const wallet = await wallets.findByIdForUpdate(
        lookup.walletId,
      );

      if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
      }

      // Bloqueia o ROLLBACK e verifica seu estado atual.
      const rollback = await transactions.findByIdForUpdate(
        rollbackId,
      );

      if (!rollback || rollback.status !== 'PENDING_REFERENCE') {
        return 'skipped';
      }

      // Função local para registrar rejeições de maneira
      // consistente, incluindo o evento na Outbox.
      const reject = async (
        failureCode: string,
      ): Promise<ResolutionOutcome> => {
        rollback.reject(failureCode);

        await transactions.save(rollback);
        await outbox.recordTransaction(rollback);

        return 'rejected';
      };

      const referenceExternalId =
        rollback.referenceExternalTransactionId;

      if (!referenceExternalId) {
        return reject('REFERENCE_REQUIRED');
      }

      const original =
        await transactions.findByProviderAndExternalId(
          rollback.providerId,
          referenceExternalId,
        );

      // A transação original ainda não chegou.
      if (!original) {
        return 'skipped';
      }

      // Somente BET, WIN e REFUND processados
      // podem receber ROLLBACK.
      if (
        original.status !== 'PROCESSED' ||
        !['BET', 'WIN', 'REFUND'].includes(original.kind)
      ) {
        return reject('INVALID_ROLLBACK_REFERENCE');
      }

      const sameReference =
        original.providerId === rollback.providerId &&
        original.walletId === rollback.walletId &&
        original.playerId === rollback.playerId &&
        original.roundId === rollback.roundId &&
        original.money.currency === rollback.money.currency &&
        original.money.toJSON().amount ===
          rollback.money.toJSON().amount;

      if (!sameReference) {
        return reject('ROLLBACK_REFERENCE_MISMATCH');
      }

      // Impede dois ROLLBACKs ativos da mesma transação.
      const existingRollback =
        await transactions.findActiveReversal(
          original.id,
          'ROLLBACK',
        );

      if (
        existingRollback &&
        existingRollback.id !== rollback.id
      ) {
        return reject('ROLLBACK_ALREADY_EXISTS');
      }

      // Uma BET já estornada por REFUND não pode
      // receber também ROLLBACK.
      if (original.kind === 'BET') {
        const existingRefund =
          await transactions.findActiveReversal(
            original.id,
            'REFUND',
          );

        if (existingRefund) {
          return reject('BET_ALREADY_REFUNDED');
        }
      }

      // Descobre a direção financeira da operação original.
      const originalLedger =
        await ledger.findByTransactionId(original.id);

      if (!originalLedger) {
        return reject('ORIGINAL_LEDGER_NOT_FOUND');
      }

      const direction = rollback.ledgerDirectionFor(
        originalLedger.direction,
      );

      if (!direction) {
        return reject('INVALID_ROLLBACK_DIRECTION');
      }

      const balanceBefore = wallet.balance;

      if (direction === 'CREDIT') {
        wallet.credit(rollback.money);
      } else {
        // Nunca permite saldo negativo.
        if (
          wallet.balance.subtract(rollback.money).isNegative()
        ) {
          return reject('INSUFFICIENT_FUNDS');
        }

        wallet.debit(rollback.money);
      }

      const balanceAfter = wallet.balance;

      rollback.setReferenceTransactionId(original.id);

      const ledgerEntry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: rollback.id,
        direction,
        money: rollback.money,
        balanceBefore,
        balanceAfter,
        createdAt: new Date(),
      });

      rollback.markProcessed();

      // Persistência financeira.
      await wallets.save(wallet);
      await transactions.save(rollback);
      await ledger.save(ledgerEntry);

      // Eventos no mesmo commit.
      await outbox.recordTransaction(rollback);

      await outbox.recordBalanceChanged(
        wallet,
        rollback,
        balanceBefore,
        direction,
      );

      return 'processed';
    });
  }
}