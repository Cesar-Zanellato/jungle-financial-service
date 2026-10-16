import { Migration } from '@mikro-orm/migrations';

export class Migration202610160003 extends Migration {
  override async up(): Promise<void> {
    // Substitui os índices separados por uma proteção
    // única para REFUND e ROLLBACK.
    this.addSql(`
      DROP INDEX IF EXISTS uq_wager_refund_once;
    `);

    this.addSql(`
      DROP INDEX IF EXISTS uq_wager_rollback_once;
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_reversal_once
      ON wager_transactions(reference_transaction_id)
      WHERE kind IN ('REFUND', 'ROLLBACK')
        AND reference_transaction_id IS NOT NULL
        AND status IN (
          'PENDING',
          'PENDING_REFERENCE',
          'PROCESSED'
        );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS uq_wager_reversal_once;
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_refund_once
      ON wager_transactions(reference_transaction_id)
      WHERE kind = 'REFUND'
        AND reference_transaction_id IS NOT NULL
        AND status IN (
          'PENDING',
          'PENDING_REFERENCE',
          'PROCESSED'
        );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_rollback_once
      ON wager_transactions(reference_transaction_id)
      WHERE kind = 'ROLLBACK'
        AND reference_transaction_id IS NOT NULL
        AND status IN (
          'PENDING',
          'PENDING_REFERENCE',
          'PROCESSED'
        );
    `);
  }
}