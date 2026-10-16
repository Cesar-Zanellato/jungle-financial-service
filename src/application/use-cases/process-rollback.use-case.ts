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

export interface ProcessRollbackInput {
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

export interface ProcessRollbackResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: string;
  idempotentReplay: boolean;
  failureCode?: string;
}

export class ProcessRollbackUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(
    input: ProcessRollbackInput,
  ): Promise<ProcessRollbackResult> {
    return this.em.transactional(async (transactionalEm) => {
      const wallets = new MikroOrmWalletRepository(transactionalEm);

      const transactions = new MikroOrmWagerTransactionRepository(transactionalEm);

      const ledger = new MikroOrmWalletLedgerRepository(transactionalEm);

      const wallet = await wallets.findByIdForUpdate(input.walletId);

      const outbox = new FinancialOutboxService(transactionalEm);

      if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
      }

      if (
        wallet.playerId !== input.playerId ||
        wallet.currency !== input.currency
      ) {
        throw new Error('WALLET_MISMATCH');
      }

      // Idempotência persistente.
      const existingByKey =
        await transactions.findByIdempotencyKey(
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
          existingByKey.roundId !== input.roundId ||
          existingByKey.gameId !== input.gameId ||
          existingByKey.money.currency !== input.currency ||
          existingByKey.money.toJSON().amount !==
            Money.from({
              amount: input.amount,
              currency: input.currency,
            }).toJSON().amount ||
          existingByKey.kind !== 'ROLLBACK' ||
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

      const rollback = WagerTransaction.create({
        id: randomUUID(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: input.payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: 'ROLLBACK',
        money: amount,
        referenceExternalTransactionId:
          input.referenceExternalTransactionId,
      });

      const original =
        await transactions.findByProviderAndExternalId(
          input.providerId,
          input.referenceExternalTransactionId,
        );

      // A transação original ainda não chegou.
      if (!original) {
        rollback.markPendingReference();
        await transactions.save(rollback);

        rollback.markPendingReference();
        await transactions.save(rollback);
        await outbox.recordTransaction(rollback);

        return {
          transactionId: rollback.id,
          status: rollback.status,
          balance: wallet.balance.toJSON().amount,
          idempotentReplay: false,
        };
      }

      // ROLLBACK só pode reverter operações financeiras
      // já processadas.
      if (
        original.status !== 'PROCESSED' ||
        !['BET', 'WIN', 'REFUND'].includes(original.kind)
      ) {
        throw new Error('INVALID_ROLLBACK_REFERENCE');
      }

      // A referência deve pertencer ao mesmo contexto.
      if (
        original.providerId !== input.providerId ||
        original.walletId !== input.walletId ||
        original.playerId !== input.playerId ||
        original.roundId !== input.roundId ||
        original.money.currency !== input.currency ||
        original.money.toJSON().amount !==
          amount.toJSON().amount
      ) {
        throw new Error('ROLLBACK_REFERENCE_MISMATCH');
      }

      // Uma transação não pode receber dois ROLLBACKs.
      const existingRollback =
        await transactions.findActiveReversal(
          original.id,
          'ROLLBACK',
        );

      if (existingRollback) {
        throw new Error('ROLLBACK_ALREADY_EXISTS');
      }

      // BET não pode ser devolvida por REFUND e ROLLBACK.
      if (original.kind === 'BET') {
        const existingRefund =
          await transactions.findActiveReversal(
            original.id,
            'REFUND',
          );

        if (existingRefund) {
          throw new Error('BET_ALREADY_REFUNDED');
        }
      }

      // Consultamos o lançamento original para descobrir
      // a direção financeira que será invertida.
      const originalLedger =
        await ledger.findByTransactionId(original.id);

      if (!originalLedger) {
        throw new Error('ORIGINAL_LEDGER_NOT_FOUND');
      }

      const direction = rollback.ledgerDirectionFor(
        originalLedger.direction,
      );

      if (!direction) {
        throw new Error('INVALID_ROLLBACK_DIRECTION');
      }

      rollback.setReferenceTransactionId(original.id);

      const balanceBefore = wallet.balance;

      if (direction === 'CREDIT') {
        wallet.credit(amount);
      } else {
        // Impede que a reversão deixe saldo negativo.
        if (wallet.balance.subtract(amount).isNegative()) {
          rollback.reject('INSUFFICIENT_FUNDS');
          await transactions.save(rollback);
          await outbox.recordTransaction(rollback);

          return {
            transactionId: rollback.id,
            status: rollback.status,
            balance: wallet.balance.toJSON().amount,
            idempotentReplay: false,
            failureCode: rollback.failureCode,
          };
        }

        wallet.debit(amount);
      }

      const balanceAfter = wallet.balance;

      const ledgerEntry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: rollback.id,
        direction,
        money: amount,
        balanceBefore,
        balanceAfter,
        createdAt: new Date(),
      });

      rollback.markProcessed();

      await wallets.save(wallet);
      await transactions.save(rollback);
      await ledger.save(ledgerEntry);
      await outbox.recordTransaction(rollback);
      await outbox.recordBalanceChanged(
        wallet,
        rollback,
        balanceBefore,
        direction,
      );

      return {
        transactionId: rollback.id,
        status: rollback.status,
        balance: wallet.balance.toJSON().amount,
        idempotentReplay: false,
      };
    });
  }
}