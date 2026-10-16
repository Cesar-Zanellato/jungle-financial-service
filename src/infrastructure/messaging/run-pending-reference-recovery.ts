import 'dotenv/config';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config.js';
import { PendingReferenceRecoveryService } from '../../application/services/pending-reference-recovery.service.js';

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    const recovery = new PendingReferenceRecoveryService(
      orm.em,
    );

    const result = await recovery.runOnce(50);

    console.log(
      'Pending reference recovery result:',
      result,
    );

    if (result.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error) => {
  console.error('Pending reference recovery failed:', error);
  process.exitCode = 1;
});