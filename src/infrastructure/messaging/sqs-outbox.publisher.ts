import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { ClaimedOutboxEvent } from '../persistence/repositories/mikro-orm-outbox.repository.js';
import type { OutboxEventPublisher } from '../../application/ports/outbox-event-publisher.js';

export interface SqsOutboxPublisherOptions {
  queueUrl: string;
  endpoint?: string;
  region?: string;
}

export class SqsOutboxPublisher implements OutboxEventPublisher {
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  constructor(options: SqsOutboxPublisherOptions) {
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

  async publish(event: ClaimedOutboxEvent): Promise<void> {
    const response = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,

        MessageBody: JSON.stringify({
          eventId: event.id,
          eventType: event.eventType,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          occurredAt: event.createdAt.toISOString(),
          payload: event.payload,
        }),

        // FIFO: preserva a ordem por agregado.
        MessageGroupId:
          `${event.aggregateType}:${event.aggregateId}`,

        // Deduplicação da fila por ID persistente.
        MessageDeduplicationId: event.id,
      }),
    );

    if (!response.MessageId) {
      throw new Error('SQS_MESSAGE_ID_MISSING');
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}