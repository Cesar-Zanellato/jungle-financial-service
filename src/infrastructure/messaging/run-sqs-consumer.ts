import 'dotenv/config';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config.js';
import { SqsInboxConsumer } from './sqs-inbox-consumer.js';

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  const consumer = new SqsInboxConsumer(
    orm.em,
    {
      queueUrl: process.env.SQS_QUEUE_URL ?? '',
      endpoint: process.env.SQS_ENDPOINT,
      region: process.env.SQS_REGION ?? 'us-east-1',
    },
  );

  try {
    const result = await consumer.runOnce();

    console.log('SQS consumer result:', result);
  } finally {
    await consumer.close();
    await orm.close(true);
  }
}

main().catch((error) => {
  console.error('SQS consumer failed:', error);
  process.exitCode = 1;
});