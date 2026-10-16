import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxProcessorService } from '../../application/services/inbox-processor.service.js';

interface FinancialEventMessage {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface SqsInboxConsumerOptions {
  queueUrl: string;
  endpoint?: string;
  region?: string;
}

export class SqsInboxConsumer {
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  constructor(
    private readonly em: EntityManager,
    options: SqsInboxConsumerOptions,
  ) {
    if (!options.queueUrl) {
      throw new Error('SQS_QUEUE_URL_REQUIRED');
    }

    this.queueUrl = options.queueUrl;

    this.client = new SQSClient({
      region: options.region ?? 'us-east-1',
      ...(options.endpoint
        ? { endpoint: options.endpoint }
        : {}),
      credentials: options.endpoint
        ? {
            accessKeyId: 'test',
            secretAccessKey: 'test',
          }
        : undefined,
    });
  }

  async runOnce(): Promise<{
    received: number;
    processed: number;
    duplicates: number;
    failed: number;
  }> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 60,
      }),
    );

    const result = {
      received: 0,
      processed: 0,
      duplicates: 0,
      failed: 0,
    };

    const processor = new InboxProcessorService(this.em);

    for (const message of response.Messages ?? []) {
      result.received++;

      try {
        if (!message.Body || !message.ReceiptHandle) {
          throw new Error('INVALID_SQS_MESSAGE');
        }

        const event = JSON.parse(
          message.Body,
        ) as FinancialEventMessage;

        if (
          typeof event.eventId !== 'string' ||
          !event.eventId ||
          typeof event.eventType !== 'string' ||
          !event.eventType ||
          typeof event.payload !== 'object' ||
          event.payload === null ||
          Array.isArray(event.payload)
        ) {
          throw new Error('INVALID_EVENT_PAYLOAD');
        }

        const outcome = await processor.process(
          {
            consumerName: 'financial-events-consumer',
            messageId: event.eventId,
            eventType: event.eventType,
            payload: event.payload,
          },
          async (transactionalEm) => {
            // Handler de integração inicial.
            // Ainda não executamos movimentações financeiras.
            // Os handlers reais serão conectados depois.
            void transactionalEm;

            console.log(
              `Processing event ${event.eventId}: ${event.eventType}`,
            );
          },
        );

        // A exclusão ocorre somente após o commit
        // da Inbox no PostgreSQL.
        await this.client.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );

        if (outcome === 'DUPLICATE') {
          result.duplicates++;
        } else {
          result.processed++;
        }
      } catch (error) {
        result.failed++;

        console.error(
          'SQS message processing failed:',
          error,
        );

        // Não excluímos mensagens que falharam.
        // O SQS poderá entregá-las novamente.
      }
    }

    return result;
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}