import { Migration } from '@mikro-orm/migrations';

export class Migration202610160004 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE outbox_events (
        id UUID PRIMARY KEY,

        event_type VARCHAR(100) NOT NULL,
        aggregate_type VARCHAR(100) NOT NULL,
        aggregate_id UUID NOT NULL,

        payload JSONB NOT NULL,

        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',

        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 10,

        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ,

        locked_by VARCHAR(255),
        locked_until TIMESTAMPTZ,

        last_error TEXT,

        CONSTRAINT chk_outbox_event_type
          CHECK (
            event_type IN (
              'WagerTransactionProcessed',
              'WagerTransactionRejected',
              'WalletBalanceChanged',
              'WagerTransactionPendingReference'
            )
          ),

        CONSTRAINT chk_outbox_status
          CHECK (
            status IN (
              'PENDING',
              'PROCESSING',
              'PUBLISHED',
              'FAILED'
            )
          ),

        CONSTRAINT chk_outbox_attempts
          CHECK (
            attempts >= 0
            AND max_attempts > 0
            AND attempts <= max_attempts
          ),

        CONSTRAINT chk_outbox_payload_object
          CHECK (jsonb_typeof(payload) = 'object'),

        CONSTRAINT chk_outbox_published_at
          CHECK (
            status <> 'PUBLISHED'
            OR published_at IS NOT NULL
          ),

        CONSTRAINT chk_outbox_lock
          CHECK (
            (
              status = 'PROCESSING'
              AND locked_by IS NOT NULL
              AND locked_until IS NOT NULL
            )
            OR
            (
              status <> 'PROCESSING'
              AND locked_by IS NULL
              AND locked_until IS NULL
            )
          )
      );
    `);

    // Busca eficiente de eventos disponíveis.
    this.addSql(`
      CREATE INDEX idx_outbox_pending
      ON outbox_events(available_at, created_at)
      WHERE status = 'PENDING';
    `);

    // Permite recuperar eventos cujo worker falhou.
    this.addSql(`
      CREATE INDEX idx_outbox_expired_locks
      ON outbox_events(locked_until)
      WHERE status = 'PROCESSING';
    `);

    // Facilita auditoria dos eventos de uma transação.
    this.addSql(`
      CREATE INDEX idx_outbox_aggregate
      ON outbox_events(
        aggregate_type,
        aggregate_id,
        created_at
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS outbox_events;
    `);
  }
}