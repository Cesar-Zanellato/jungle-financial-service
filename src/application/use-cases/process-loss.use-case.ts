import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';
import { Money } from '../../domain/value-objects/money.js';
import { WagerTransaction } from '../../domain/entities/wager-transaction.js';
import { MikroOrmWalletRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { FinancialOutboxService } from '../services/financial-outbox.service.js';

export interface ProcessLossInput {
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

export interface ProcessLossResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: string;
  idempotentReplay: boolean;
  failureCode?: string;
}

export class ProcessLossUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: ProcessLossInput): Promise<ProcessLossResult> {
    return this.em.transactional(async (transactionalEm) => {
      const wallets = new MikroOrmWalletRepository(transactionalEm);

      const transactions = new MikroOrmWagerTransactionRepository(transactionalEm);

      const outbox = new FinancialOutboxService(transactionalEm);

      // Mantemos o bloqueio para serializar operações
      // da mesma carteira, mesmo sem alterar seu saldo.
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
          existingByKey.kind !== 'LOSS'
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
        kind: 'LOSS',
        money: amount,
      });

      // LOSS registra somente o resultado da aposta.
      // Não executamos wallet.debit() nem wallet.credit().
      // Também não criamos WalletLedgerEntry.
      transaction.markProcessed();

      // Persiste o resultado da LOSS.
      await transactions.save(transaction);

      // Registra o evento na mesma transação SQL.
      await outbox.recordTransaction(transaction);

      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON().amount,
        idempotentReplay: false,
      };
    });
  }
}