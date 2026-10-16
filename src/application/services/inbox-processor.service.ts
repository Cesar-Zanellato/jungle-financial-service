import type { EntityManager } from '@mikro-orm/postgresql';
import { MikroOrmInboxRepository } from '../../infrastructure/persistence/repositories/mikro-orm-inbox.repository.js';

export interface InboxMessage {
  consumerName: string;
  messageId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export type InboxProcessingResult =
  | 'PROCESSED'
  | 'DUPLICATE';

export class InboxProcessorService {
  constructor(private readonly em: EntityManager) {}

  async process(
    message: InboxMessage,
    handler: (em: EntityManager) => Promise<void>,
  ): Promise<InboxProcessingResult> {
    return this.em.fork().transactional(
      async (transactionalEm) => {
        const inbox = new MikroOrmInboxRepository(
          transactionalEm,
        );

        const registered = await inbox.register({
          consumerName: message.consumerName,
          messageId: message.messageId,
          eventType: message.eventType,
          payload: message.payload,
        });

        if (!registered) {
          const processed = await inbox.isProcessed(
            message.consumerName,
            message.messageId,
          );

          if (processed) {
            return 'DUPLICATE';
          }

          // Um registro PROCESSING persistido indica
          // um estado incompleto que exige investigação.
          throw new Error('INBOX_MESSAGE_NOT_COMPLETED');
        }

        // O processamento acontece na mesma transação
        // em que a mensagem foi registrada.
        await handler(transactionalEm);

        const completed = await inbox.markProcessed(
          message.consumerName,
          message.messageId,
        );

        if (!completed) {
          throw new Error('INBOX_COMPLETION_FAILED');
        }

        return 'PROCESSED';
      },
    );
  }
}