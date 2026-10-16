import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';
import { Money } from '../../domain/value-objects/money.js';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.js';
import { WagerTransaction } from '../../domain/entities/wager-transaction.js';
import { MikroOrmWalletRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmOutboxRepository } from '../../infrastructure/persistence/repositories/mikro-orm-outbox.repository.js';
import { ResolvePendingRefundsUseCase } from './resolve-pending-refunds.use-case.js';
import { ResolvePendingRollbacksUseCase } from './resolve-pending-rollbacks.use-case.js';

export interface ProcessBetInput {
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
}

export interface ProcessBetResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: string;
  idempotentReplay: boolean;
  failureCode?: string;
}

export class ProcessBetUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(
    input: ProcessBetInput,
  ): Promise<ProcessBetResult> {
    const result = await this.em.transactional(async (transactionalEm) => {
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

      // A Outbox utiliza o mesmo EntityManager transacional.
      const outbox = new MikroOrmOutboxRepository(
        transactionalEm,
      );

      // Serializa operações concorrentes na mesma carteira.
      const wallet = await wallets.findByIdForUpdate(
        input.walletId,
      );

      if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
      }

      if (
        wallet.playerId !== input.playerId ||
        wallet.currency !== input.currency
      ) {
        throw new Error('WALLET_MISMATCH');
      }

      // Verifica se esta operação já foi registrada.
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
          existingByKey.kind !== 'BET'
        ) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }

        // Não cria eventos novamente em um replay.
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

      const transaction = WagerTransaction.create({
        id: randomUUID(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: input.payloadHash,
        walletId: wallet.id,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: 'BET',
        money: amount,
      });

      const balanceBefore = wallet.balance;

      // Rejeita a aposta quando o saldo é insuficiente.
      if (wallet.balance.subtract(amount).isNegative()) {
        transaction.reject('INSUFFICIENT_FUNDS');

        await transactions.save(transaction);

        // A rejeição também precisa gerar um evento durável.
        await outbox.save({
          eventType: 'WagerTransactionRejected',
          aggregateType: 'WagerTransaction',
          aggregateId: transaction.id,
          payload: {
            transactionId: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId:
              transaction.externalTransactionId,
            walletId: wallet.id,
            playerId: input.playerId,
            kind: 'BET',
            status: transaction.status,
            failureCode: transaction.failureCode,
          },
        });

        // Nenhum WalletBalanceChanged é gerado,
        // pois o saldo não foi modificado.
        return {
          transactionId: transaction.id,
          status: transaction.status,
          balance: wallet.balance.toJSON().amount,
          idempotentReplay: false,
          failureCode: transaction.failureCode,
        };
      }

      // Executa o débito.
      wallet.debit(amount);

      const balanceAfter = wallet.balance;

      const ledgerEntry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: 'DEBIT',
        money: amount,
        balanceBefore,
        balanceAfter,
        createdAt: new Date(),
      });

      transaction.markProcessed();

      // Persistência financeira.
      await wallets.save(wallet);
      await transactions.save(transaction);
      await ledger.save(ledgerEntry);

      // Evento de transação processada.
      await outbox.save({
        eventType: 'WagerTransactionProcessed',
        aggregateType: 'WagerTransaction',
        aggregateId: transaction.id,
        payload: {
          transactionId: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId:
            transaction.externalTransactionId,
          walletId: wallet.id,
          playerId: input.playerId,
          kind: 'BET',
          status: transaction.status,
          amount: amount.toJSON().amount,
          currency: input.currency,
        },
      });

      // Evento de alteração de saldo.
      await outbox.save({
        eventType: 'WalletBalanceChanged',
        aggregateType: 'Wallet',
        aggregateId: wallet.id,
        payload: {
          transactionId: transaction.id,
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balanceBefore: balanceBefore.toJSON().amount,
          balanceAfter: balanceAfter.toJSON().amount,
          direction: 'DEBIT',
          amount: amount.toJSON().amount,
          walletVersion: wallet.version,
        },
      });

      // Todos os registros serão confirmados juntos.
      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON().amount,
        idempotentReplay: false,
      };
   
    });

    // A recuperação acontece somente após o commit
    if (result.status === 'PROCESSED' && !result.idempotentReplay){
      try {
        const refunds = new ResolvePendingRefundsUseCase(
          this.em.fork(),
        );
        await refunds.execute({
          providerId: input.providerId,
          referenceExternalTransactionId:
            input.externalTransactionId,
        });
      } catch (error) {
        console.error(
          'Falha na recuperação de REFUNDs após BET:',
          {
            transactionId: result.transactionId,
            error,
          },
        );
      }
      try {
        const rollbacks = new ResolvePendingRollbacksUseCase(
          this.em.fork(),
        );
        await rollbacks.execute({
          providerId: input.providerId,
          referenceExternalTransactionId:
            input.externalTransactionId,
        });
      } catch (error) {
        console.error(
          'Falha na recuperação de ROLLBACKs após BET:',
          {
            transactionId: result.transactionId,
            error,
          },
        );
      }
    }

    return result;

  }
}