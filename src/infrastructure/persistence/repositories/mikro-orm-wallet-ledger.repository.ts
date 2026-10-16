import type { EntityManager } from '@mikro-orm/postgresql';

import type { WalletLedgerRepository } from '../../../domain/repositories/wallet-ledger.repository.js';

import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.js';

import { Money } from '../../../domain/value-objects/money.js';

type LedgerRow = {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: 'DEBIT' | 'CREDIT';
  currency: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
};

export class MikroOrmWalletLedgerRepository
  implements WalletLedgerRepository
{
  constructor(private readonly em: EntityManager) {}

  async save(entry: WalletLedgerEntry): Promise<void> {
    await this.em.execute(
      `
        INSERT INTO ledger_entries (
          id,
          wallet_id,
          transaction_id,
          direction,
          currency,
          amount,
          balance_before,
          balance_after,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.currency,
        entry.money.toJSON().amount,
        entry.balanceBefore.toJSON().amount,
        entry.balanceAfter.toJSON().amount,
        entry.createdAt,
      ],
    );
  }

  async findByTransactionId(
    transactionId: string,
  ): Promise<WalletLedgerEntry | null> {
    const rows = await this.em.execute<LedgerRow[]>(
      `
        SELECT
          id,
          wallet_id,
          transaction_id,
          direction,
          currency,
          amount::text AS amount,
          balance_before::text AS balance_before,
          balance_after::text AS balance_after,
          created_at
        FROM ledger_entries
        WHERE transaction_id = ?
        LIMIT 1
      `,
      [transactionId],
    );

    const row = rows[0];

    if (!row) {
      return null;
    }

    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.wallet_id,
      transactionId: row.transaction_id,
      direction: row.direction,
      money: Money.from({
        amount: row.amount,
        currency: row.currency,
      }),
      balanceBefore: Money.from({
        amount: row.balance_before,
        currency: row.currency,
      }),
      balanceAfter: Money.from({
        amount: row.balance_after,
        currency: row.currency,
      }),
      createdAt: new Date(row.created_at),
    });
  }

  withEntityManager(
    em: EntityManager,
  ): MikroOrmWalletLedgerRepository {
    return new MikroOrmWalletLedgerRepository(em);
  }
}