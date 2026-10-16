import { Migration } from '@mikro-orm/migrations';

export class Migration202610160005 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        id UUID PRIMARY KEY,
        consumer_name VARCHAR(100) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,

        status VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',

        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,

        CONSTRAINT uq_inbox_consumer_message
          UNIQUE (consumer_name, message_id),

        CONSTRAINT chk_inbox_status
          CHECK (status IN ('PROCESSING', 'PROCESSED')),

        CONSTRAINT chk_inbox_payload
          CHECK (jsonb_typeof(payload) = 'object'),

        CONSTRAINT chk_inbox_processed_at
          CHECK (
            (status = 'PROCESSING' AND processed_at IS NULL)
            OR
            (status = 'PROCESSED' AND processed_at IS NOT NULL)
          )
      );
    `);

    this.addSql(`
      CREATE INDEX idx_inbox_consumer_status
      ON inbox_messages (consumer_name, status);
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
  }
}