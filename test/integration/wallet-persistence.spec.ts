import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';

describe('WalletRepository - PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close();
    }
  });

  test('deve persistir e recuperar uma carteira', async () => {
    const em = orm.em.fork();

    const repository = new MikroOrmWalletRepository(em);

    const walletId = randomUUID();
    const playerId = `test-player-${randomUUID()}`;

    const wallet = Wallet.open(
      walletId,
      playerId,
      'BRL',
    );

    await repository.save(wallet);

    em.clear();

    const recovered = await repository.findById(walletId);

    expect(recovered).not.toBeNull();

    expect(recovered?.id).toBe(walletId);
    expect(recovered?.playerId).toBe(playerId);
    expect(recovered?.currency).toBe('BRL');

    expect(recovered?.balance.toJSON().amount).toBe('0.00');

    expect(recovered?.version).toBe(1);
  });
});