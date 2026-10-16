import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';
import { Money } from '../../domain/value-objects/money.js';
import { WagerTransaction } from '../../domain/entities/wager-transaction.js';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.js';
import { MikroOrmWalletRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';
import { FinancialOutboxService } from '../services/financial-outbox.service.js';

export interface ProcessRefundInput {
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  playerId: string;
  roundId: string;
  gameId: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string;
}

export interface ProcessRefundResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: string;
  idempotentReplay: boolean;
  failureCode?: string;
}

export class ProcessRefundUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(
    input: ProcessRefundInput,
  ): Promise<ProcessRefundResult> {
    return this.em.transactional(async (transactionalEm) => {
      const wallets = new MikroOrmWalletRepository(transactionalEm);
      const transactions = new MikroOrmWagerTransactionRepository(transactionalEm);
      const ledger = new MikroOrmWalletLedgerRepository(transactionalEm);
      const outbox = new FinancialOutboxService(transactionalEm);

      const wallet = await wallets.findByIdForUpdate(input.walletId);

      if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
      }

      if (
        wallet.playerId !== input.playerId ||
        wallet.currency !== input.currency
      ) {
        throw new Error('WALLET_MISMATCH');
      }

      const existingByKey = await transactions.findByIdempotencyKey(
        input.providerId,
        input.idempotencyKey,
      );

      if (existingByKey) {
        if (
          !existingByKey.matchesPayload(input.payloadHash) ||
          existingByKey.externalTransactionId !==
            input.externalTransactionId ||
          existingByKey.walletId !== input.walletId ||
          existingByKey.playerId !== input.playerId ||
          existingByKey.kind !== 'REFUND' ||
          existingByKey.referenceExternalTransactionId !==
            input.referenceExternalTransactionId
        ) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }

        return {
          transactionId: existingByKey.id,
          status: existingByKey.status,
          balance: wallet.balance.toJSON().amount,
          idempotentReplay: true,
          failureCode: existingByKey.failureCode,
        };
      }

      const existingByExternalId =
        await transactions.findByProviderAndExternalId(
          input.providerId,
          input.externalTransactionId,
        );

      if (existingByExternalId) {
        throw new Error('EXTERNAL_TRANSACTION_CONFLICT');
      }

      const amount = Money.from({
        amount: input.amount,
        currency: input.currency,
      });

      if (!amount.isPositive()) {
        throw new Error('INVALID_TRANSACTION_AMOUNT');
      }

      const refund = WagerTransaction.create({
        id: randomUUID(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: input.payloadHash,
        walletId: wallet.id,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: 'REFUND',
        money: amount,
        referenceExternalTransactionId:
          input.referenceExternalTransactionId,
      });

      const original =
        await transactions.findByProviderAndExternalId(
          input.providerId,
          input.referenceExternalTransactionId,
        );

      // A BET ainda não chegou ao sistema.
      if (!original) {
        refund.markPendingReference();
        await transactions.save(refund);
        await outbox.recordTransaction(refund);

        return {
          transactionId: refund.id,
          status: refund.status,
          balance: wallet.balance.toJSON().amount,
          idempotentReplay: false,
        };
      }

      // A referência precisa ser uma BET já processada.
      if (
        original.kind !== 'BET' ||
        original.status !== 'PROCESSED'
      ) {
        throw new Error('INVALID_REFUND_REFERENCE');
      }

      if (
        original.providerId !== input.providerId ||
        original.walletId !== input.walletId ||
        original.playerId !== input.playerId ||
        original.roundId !== input.roundId ||
        original.money.currency !== input.currency ||
        original.money.toJSON().amount !==
          amount.toJSON().amount
      ) {
        throw new Error('REFUND_REFERENCE_MISMATCH');
      }

      const existingRefund =
        await transactions.findActiveReversal(
          original.id,
          'REFUND',
        );

      if (existingRefund) {
        throw new Error('REFUND_ALREADY_EXISTS');
      }

      // Impede que uma BET já revertida por ROLLBACK
      // receba também um REFUND.
      const existingRollback =
        await transactions.findActiveReversal(
          original.id,
          'ROLLBACK',
        );

      if (existingRollback) {
        throw new Error('BET_ALREADY_ROLLED_BACK');
      }

      refund.setReferenceTransactionId(original.id);

      refund.setReferenceTransactionId(original.id);

      const balanceBefore = wallet.balance;

      // REFUND devolve o valor da BET original.
      wallet.credit(amount);

      const balanceAfter = wallet.balance;

      const ledgerEntry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: refund.id,
        direction: 'CREDIT',
        money: amount,
        balanceBefore,
        balanceAfter,
        createdAt: new Date(),
      });

      refund.markProcessed();

      await wallets.save(wallet);
      await transactions.save(refund);
      await ledger.save(ledgerEntry);

      await outbox.recordTransaction(refund);

      await outbox.recordBalanceChanged(
        wallet,
        refund,
        balanceBefore,
        'CREDIT',
      );

      return {
        transactionId: refund.id,
        status: refund.status,
        balance: wallet.balance.toJSON().amount,
        idempotentReplay: false,
      };
    });
  }
}