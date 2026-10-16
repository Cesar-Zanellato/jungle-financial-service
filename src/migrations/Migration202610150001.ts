import { Migration } from '@mikro-orm/migrations';

export class Migration202610150001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,

        player_id VARCHAR(255) NOT NULL,

        currency VARCHAR(3) NOT NULL,

        balance NUMERIC(20, 2) NOT NULL DEFAULT 0,

        version INTEGER NOT NULL DEFAULT 1,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT uq_wallet_player_currency
          UNIQUE (player_id, currency),

        CONSTRAINT chk_wallet_balance_non_negative
          CHECK (balance >= 0),

        CONSTRAINT chk_wallet_version_positive
          CHECK (version >= 1)
      );
    `);

    this.addSql(`
      CREATE INDEX idx_wallet_player_id
      ON wallets (player_id);
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS wallets;
    `);
  }
}
