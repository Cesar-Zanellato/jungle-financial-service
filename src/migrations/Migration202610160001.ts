import { Migration } from '@mikro-orm/migrations';

export class Migration202610160001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL,
        transaction_id UUID NOT NULL,
        direction VARCHAR(6) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        balance_before NUMERIC(20, 2) NOT NULL,
        balance_after NUMERIC(20, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT fk_ledger_wallet
          FOREIGN KEY (wallet_id)
          REFERENCES wallets(id),

        CONSTRAINT uq_ledger_wallet_transaction
          UNIQUE (wallet_id, transaction_id),

        CONSTRAINT chk_ledger_direction
          CHECK (direction IN ('DEBIT', 'CREDIT')),

        CONSTRAINT chk_ledger_amount_positive
          CHECK (amount > 0),

        CONSTRAINT chk_ledger_balance_before
          CHECK (balance_before >= 0),

        CONSTRAINT chk_ledger_balance_after
          CHECK (balance_after >= 0),

        CONSTRAINT chk_ledger_balance_consistency
          CHECK (
            (direction = 'CREDIT'
              AND balance_after = balance_before + amount)
            OR
            (direction = 'DEBIT'
              AND balance_after = balance_before - amount)
          )
      );
    `);

    this.addSql(`
      CREATE INDEX idx_ledger_wallet_created
      ON ledger_entries(wallet_id, created_at, id);
    `);

    // Impede alterações e exclusões de lançamentos existentes.
    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'LEDGER_IMMUTABLE';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER trg_ledger_immutable
      BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION prevent_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS ledger_entries;
    `);

    this.addSql(`
      DROP FUNCTION IF EXISTS prevent_ledger_mutation();
    `);
  }
}