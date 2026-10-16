import 'dotenv/config';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config.js';
import { OutboxWorkerService } from '../../application/services/outbox-worker.service.js';
import { SqsOutboxPublisher } from './sqs-outbox.publisher.js';

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  const publisher = new SqsOutboxPublisher({
    queueUrl: process.env.SQS_QUEUE_URL ?? '',
    endpoint: process.env.SQS_ENDPOINT,
    region: process.env.SQS_REGION ?? 'us-east-1',
  });

  try {
    const worker = new OutboxWorkerService(
      orm.em,
      publisher,
      {
        batchSize: 10,
        leaseSeconds: 60,
      },
    );

    const result = await worker.runOnce();

    console.log('Outbox worker result:', result);
  } finally {
    await publisher.close();
    await orm.close(true);
  }
}

main().catch((error) => {
  console.error('Outbox worker failed:', error);
  process.exitCode = 1;
});