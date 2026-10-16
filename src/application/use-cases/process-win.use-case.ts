import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';
import { Money } from '../../domain/value-objects/money.js';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.js';
import { WagerTransaction } from '../../domain/entities/wager-transaction.js';
import { MikroOrmWalletRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { FinancialOutboxService } from '../services/financial-outbox.service.js';
import { ResolvePendingRollbacksUseCase } from './resolve-pending-rollbacks.use-case.js';

export interface ProcessWinInput {
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

export interface ProcessWinResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: string;
  idempotentReplay: boolean;
  failureCode?: string;
}

export class ProcessWinUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: ProcessWinInput): Promise<ProcessWinResult> {
    const result = await this.em.transactional(async (transactionalEm) => {
      const wallets = new MikroOrmWalletRepository(transactionalEm);

      const transactions = new MikroOrmWagerTransactionRepository(transactionalEm);

      const ledger = new MikroOrmWalletLedgerRepository(transactionalEm);

      const outbox = new FinancialOutboxService(transactionalEm);

      // Bloqueia a carteira para impedir alterações simultâneas.
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

      // Verifica se a operação já foi processada.
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
          existingByKey.kind !== 'WIN'
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

      // Cria a transação financeira.
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
        kind: 'WIN',
        money: amount,
      });

      const balanceBefore = wallet.balance;

      // WIN aumenta o saldo, diferentemente da BET.
      wallet.credit(amount);

      const balanceAfter = wallet.balance;

      // Registra o crédito no ledger.
      const ledgerEntry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: 'CREDIT',
        money: amount,
        balanceBefore,
        balanceAfter,
        createdAt: new Date(),
      });

      transaction.markProcessed();
      
      await wallets.save(wallet);
      await transactions.save(transaction);
      await ledger.save(ledgerEntry);

      // Registra a WIN processada na Outbox.
      await outbox.recordTransaction(transaction);

      // Registra a alteração do saldo causada pela WIN.
      await outbox.recordBalanceChanged(
        wallet,
        transaction,
        balanceBefore,
        'CREDIT',
      );

      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON().amount,
        idempotentReplay: false,
      };
   
    });

    // ROLLBACKs pendentes podem referenciar uma WIN.
    
    // A WIN já foi confirmada no PostgreSQL.
    if (result.status === 'PROCESSED' && !result.idempotentReplay){
      try {
        const resolver = new ResolvePendingRollbacksUseCase(
          this.em.fork(),
        );
        await resolver.execute({
          providerId: input.providerId,
          referenceExternalTransactionId:
            input.externalTransactionId,
        });
      } catch (error) {
        console.error(
          'Falha na recuperação de ROLLBACKs após WIN:',
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
