import 'dotenv/config';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config.js';
import { PendingReferenceRecoveryService } from '../../application/services/pending-reference-recovery.service.js';

const INTERVAL_MS = 10_000;
const BATCH_SIZE = 50;

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  const recovery = new PendingReferenceRecoveryService(
    orm.em,
  );

  let running = true;
  let stopping = false;
  let wakeUp: (() => void) | undefined;

  const stop = () => {
    if (stopping) return;

    stopping = true;
    running = false;

    console.log(
      'Encerrando worker de recuperação...',
    );

    wakeUp?.();
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timeout = setTimeout(() => {
        wakeUp = undefined;
        resolve();
      }, ms);

      wakeUp = () => {
        clearTimeout(timeout);
        wakeUp = undefined;
        resolve();
      };
    });

  console.log(
    'Worker de recuperação iniciado.',
  );

  try {
    while (running) {
      try {
        const result = await recovery.runOnce(
          BATCH_SIZE,
        );

        if (
          result.referencesFound > 0 ||
          result.failed > 0
        ) {
          console.log(
            'Resultado da recuperação:',
            result,
          );
        }
      } catch (error) {
        console.error(
          'Erro no ciclo de recuperação:',
          error,
        );
      }

      if (running) {
        await wait(INTERVAL_MS);
      }
    }
  } finally {
    await orm.close(true);

    console.log(
      'Worker de recuperação encerrado.',
    );
  }
}

main().catch((error) => {
  console.error(
    'Falha fatal no worker:',
    error,
  );

  process.exitCode = 1;
});