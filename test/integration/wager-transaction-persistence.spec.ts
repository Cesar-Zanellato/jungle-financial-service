import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import { WagerTransaction } from '../../src/domain/entities/wager-transaction.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';

describe('WagerTransactionRepository - PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  test('deve persistir, consultar e atualizar uma transação', async () => {
    const em = orm.em.fork();

    const walletRepository = new MikroOrmWalletRepository(em);

    const transactionRepository = new MikroOrmWagerTransactionRepository(em);

    const walletId = randomUUID();
    const transactionId = randomUUID();
    const providerId = `provider-${randomUUID()}`;
    const externalTransactionId = `bet-${randomUUID()}`;
    const idempotencyKey = randomUUID();

    const wallet = Wallet.open(
      walletId,
      `player-${randomUUID()}`,
      'BRL',
    );

    await walletRepository.save(wallet);

    const transaction = WagerTransaction.create({
      id: transactionId,
      providerId,
      externalTransactionId,
      idempotencyKey,
      payloadHash: 'a'.repeat(64),
      walletId,
      playerId: wallet.playerId,
      roundId: 'round-001',
      gameId: 'game-001',
      kind: 'BET',
      money: Money.from({
        amount: '25.00',
        currency: 'BRL',
      }),
    });

    await transactionRepository.save(transaction);

    // Usa outro EntityManager para consultar o banco,
    // evitando depender apenas do cache da instância original.
    const readRepository =
      new MikroOrmWagerTransactionRepository(orm.em.fork());

    const found = await readRepository.findById(transactionId);

    expect(found).not.toBeNull();
    expect(found?.status).toBe('PENDING');
    expect(found?.money.toJSON().amount).toBe('25.00');

    const byExternalId =
      await readRepository.findByProviderAndExternalId(
        providerId,
        externalTransactionId,
      );

    expect(byExternalId?.id).toBe(transactionId);

    const byIdempotencyKey =
      await readRepository.findByIdempotencyKey(
        providerId,
        idempotencyKey,
      );

    expect(byIdempotencyKey?.id).toBe(transactionId);

    transaction.markProcessed();

    await transactionRepository.save(transaction);

    // Nova consulta em outro contexto de persistência.
    const updatedRepository =
      new MikroOrmWagerTransactionRepository(orm.em.fork());

    const updated =
      await updatedRepository.findById(transactionId);

    expect(updated?.status).toBe('PROCESSED');
    expect(updated?.processedAt).toBeDefined();
  });
});