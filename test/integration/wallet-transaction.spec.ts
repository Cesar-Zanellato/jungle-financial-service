import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';

import config from '../../src/mikro-orm.test.config.js';

import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';

import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';

describe('Wallet - Transações PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close();
    }
  });

  async function createTestWallet(): Promise<string> {
    const walletId = randomUUID();
    const playerId = `test-player-${randomUUID()}`;

    const em = orm.em.fork();
    const repository = new MikroOrmWalletRepository(em);

    await repository.save(
      Wallet.open(walletId, playerId, 'BRL'),
    );

    return walletId;
  }

  test('deve confirmar uma transação com COMMIT', async () => {
    const walletId = await createTestWallet();

    const em = orm.em.fork();

    await em.transactional(async (transactionEm) => {
      const repository = new MikroOrmWalletRepository(
        transactionEm,
      );

      const wallet = await repository.findByIdForUpdate(
        walletId,
      );

      if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
      }

      wallet.credit(
        Money.from({
          amount: '100.00',
          currency: 'BRL',
        }),
      );

      await repository.save(wallet);
    });

    const verificationEm = orm.em.fork();

    const verificationRepository =
      new MikroOrmWalletRepository(verificationEm);

    const persistedWallet =
      await verificationRepository.findById(walletId);

    expect(
      persistedWallet?.balance.toJSON().amount,
    ).toBe('100.00');

    expect(persistedWallet?.version).toBe(2);
  });

  test('deve desfazer uma transação com ROLLBACK', async () => {
    const walletId = await createTestWallet();

    const em = orm.em.fork();

    await expect(
      em.transactional(async (transactionEm) => {
        const repository = new MikroOrmWalletRepository(
          transactionEm,
        );

        const wallet = await repository.findByIdForUpdate(
          walletId,
        );

        if (!wallet) {
          throw new Error('WALLET_NOT_FOUND');
        }

        wallet.credit(
          Money.from({
            amount: '250.00',
            currency: 'BRL',
          }),
        );

        await repository.save(wallet);

        // Simula uma falha antes do COMMIT.
        throw new Error('SIMULATED_FAILURE');
      }),
    ).rejects.toThrow('SIMULATED_FAILURE');

    const verificationEm = orm.em.fork();

    const verificationRepository =
      new MikroOrmWalletRepository(verificationEm);

    const persistedWallet =
      await verificationRepository.findById(walletId);

    expect(
      persistedWallet?.balance.toJSON().amount,
    ).toBe('0.00');

    expect(persistedWallet?.version).toBe(1);
  });
});