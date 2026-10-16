import { Migration } from '@mikro-orm/migrations';

export class Migration202610160002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,

        provider_id VARCHAR(255) NOT NULL,
        external_transaction_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,

        wallet_id UUID NOT NULL,
        player_id VARCHAR(255) NOT NULL,
        round_id VARCHAR(255) NOT NULL,
        game_id VARCHAR(255) NOT NULL,

        kind VARCHAR(20) NOT NULL,

        amount NUMERIC(20, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,

        reference_external_transaction_id VARCHAR(255),
        reference_transaction_id UUID,

        status VARCHAR(30) NOT NULL,
        failure_code VARCHAR(100),

        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,

        CONSTRAINT fk_wager_wallet
          FOREIGN KEY (wallet_id)
          REFERENCES wallets(id),

        CONSTRAINT uq_wager_provider_external
          UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT uq_wager_provider_idempotency
          UNIQUE (provider_id, idempotency_key),

        CONSTRAINT chk_wager_amount_positive
          CHECK (amount > 0),

        CONSTRAINT chk_wager_kind
          CHECK (
            kind IN (
              'OPENING',
              'BET',
              'WIN',
              'LOSS',
              'REFUND',
              'ROLLBACK'
            )
          ),

        CONSTRAINT chk_wager_status
          CHECK (
            status IN (
              'PENDING',
              'PENDING_REFERENCE',
              'PROCESSED',
              'REJECTED',
              'FAILED'
            )
          ),

        CONSTRAINT chk_wager_reference_required
          CHECK (
            kind NOT IN ('REFUND', 'ROLLBACK')
            OR reference_external_transaction_id IS NOT NULL
          ),

        CONSTRAINT fk_wager_reference
          FOREIGN KEY (reference_transaction_id)
          REFERENCES wager_transactions(id)
      );
    `);

    this.addSql(`
      CREATE INDEX idx_wager_wallet_created
      ON wager_transactions(wallet_id, created_at DESC);
    `);

    this.addSql(`
      CREATE INDEX idx_wager_pending_reference
      ON wager_transactions(created_at)
      WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_refund_once
      ON wager_transactions(reference_transaction_id)
      WHERE kind = 'REFUND'
        AND reference_transaction_id IS NOT NULL
        AND status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED');
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_rollback_once
      ON wager_transactions(reference_transaction_id)
      WHERE kind = 'ROLLBACK'
        AND reference_transaction_id IS NOT NULL
        AND status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED');
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
  }
}