import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { InboxProcessorService } from '../../src/application/services/inbox-processor.service.js';

describe('Inbox recovery', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('reprocessa após falha e impede duplicação após commit', async () => {
    const messageId = randomUUID();
    const consumerName = 'inbox-recovery-test';

    const processor = new InboxProcessorService(orm.em);

    const message = {
      consumerName,
      messageId,
      eventType: 'WagerTransactionProcessed',
      payload: {
        test: true,
      },
    };

    // Primeira tentativa: falha antes do commit.
    await expect(
      processor.process(message, async () => {
        throw new Error('SIMULATED_PROCESSING_FAILURE');
      }),
    ).rejects.toThrow('SIMULATED_PROCESSING_FAILURE');

    const afterFailure = await orm.em.getConnection().execute<
      Array<{ count: string }>
    >(
      `
      SELECT COUNT(*)::text AS count
      FROM inbox_messages
      WHERE consumer_name = ?
        AND message_id = ?
      `,
      [consumerName, messageId],
    );

    // A transação inteira foi revertida.
    expect(afterFailure[0]?.count).toBe('0');

    let executions = 0;

    // Segunda tentativa: processamento bem-sucedido.
    const processed = await processor.process(
      message,
      async () => {
        executions++;
      },
    );

    expect(processed).toBe('PROCESSED');
    expect(executions).toBe(1);

    // Terceira tentativa: mesma mensagem.
    const duplicate = await processor.process(
      message,
      async () => {
        executions++;
      },
    );

    expect(duplicate).toBe('DUPLICATE');

    // O handler não foi executado novamente.
    expect(executions).toBe(1);

    const afterSuccess = await orm.em.getConnection().execute<
      Array<{ status: string }>
    >(
      `
      SELECT status
      FROM inbox_messages
      WHERE consumer_name = ?
        AND message_id = ?
      `,
      [consumerName, messageId],
    );

    expect(afterSuccess[0]?.status).toBe('PROCESSED');
  });
});