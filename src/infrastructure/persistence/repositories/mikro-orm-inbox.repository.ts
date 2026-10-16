import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';

export interface RegisterInboxMessageInput {
  consumerName: string;
  messageId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export class MikroOrmInboxRepository {
  constructor(private readonly em: EntityManager) {}

  async register(
    input: RegisterInboxMessageInput,
  ): Promise<boolean> {
    const rows = await this.em.execute<Array<{ id: string }>>(
      `
      INSERT INTO inbox_messages (
        id,
        consumer_name,
        message_id,
        event_type,
        payload,
        status,
        received_at
      )
      VALUES (
        ?, ?, ?, ?, CAST(? AS jsonb),
        'PROCESSING',
        NOW()
      )
      ON CONFLICT (consumer_name, message_id)
      DO NOTHING
      RETURNING id
      `,
      [
        randomUUID(),
        input.consumerName,
        input.messageId,
        input.eventType,
        JSON.stringify(input.payload),
      ],
    );

    return rows.length === 1;
  }

  async markProcessed(
    consumerName: string,
    messageId: string,
  ): Promise<boolean> {
    const rows = await this.em.execute<Array<{ id: string }>>(
      `
      UPDATE inbox_messages
      SET
        status = 'PROCESSED',
        processed_at = NOW()
      WHERE consumer_name = ?
        AND message_id = ?
        AND status = 'PROCESSING'
      RETURNING id
      `,
      [consumerName, messageId],
    );

    return rows.length === 1;
  }

  async isProcessed(
    consumerName: string,
    messageId: string,
  ): Promise<boolean> {
    const rows = await this.em.execute<Array<{ id: string }>>(
      `
      SELECT id
      FROM inbox_messages
      WHERE consumer_name = ?
        AND message_id = ?
        AND status = 'PROCESSED'
      LIMIT 1
      `,
      [consumerName, messageId],
    );

    return rows.length > 0;
  }
}