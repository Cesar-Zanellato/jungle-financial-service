import type { EntityManager } from '@mikro-orm/postgresql';

export interface WalletReconciliationResult {
  walletId: string;
  currency: string;
  materializedBalance: string;
  ledgerBalance: string;
  consistent: boolean;
}

export class WalletReconciliationService {
  constructor(private readonly em: EntityManager) {}

  async reconcile(
    walletId: string,
  ): Promise<WalletReconciliationResult> {
    const rows = await this.em.getConnection().execute<
      Array<{
        wallet_id: string;
        currency: string;
        materialized_balance: string;
        ledger_balance: string;
        consistent: boolean;
      }>
    >(
      `
      SELECT
        w.id AS wallet_id,
        w.currency,
        w.balance::text AS materialized_balance,

        COALESCE(
          SUM(
            CASE
              WHEN l.direction = 'CREDIT'
                THEN l.amount
              WHEN l.direction = 'DEBIT'
                THEN -l.amount
              ELSE 0
            END
          ),
          0
        )::text AS ledger_balance,

        w.balance = COALESCE(
          SUM(
            CASE
              WHEN l.direction = 'CREDIT'
                THEN l.amount
              WHEN l.direction = 'DEBIT'
                THEN -l.amount
              ELSE 0
            END
          ),
          0
        ) AS consistent

      FROM wallets w

      LEFT JOIN ledger_entries l
        ON l.wallet_id = w.id

      WHERE w.id = ?

      GROUP BY
        w.id,
        w.currency,
        w.balance
      `,
      [walletId],
    );

    const row = rows[0];

    if (!row) {
      throw new Error('WALLET_NOT_FOUND');
    }

    return {
      walletId: row.wallet_id,
      currency: row.currency,
      materializedBalance: row.materialized_balance,
      ledgerBalance: row.ledger_balance,
      consistent: row.consistent,
    };
  }
}