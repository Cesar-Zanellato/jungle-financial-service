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

import { WalletTransactionService } from '../../src/application/services/wallet-transaction.service.js';

describe('Wallet - Concorrência PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close();
    }
  });

  test('deve impedir duas apostas que ultrapassam o saldo', async () => {
    const walletId = randomUUID();
    const playerId = `concurrency-player-${randomUUID()}`;

    // 1. Cria a carteira com saldo zero.
    const setupEm = orm.em.fork();

    const setupRepository = new MikroOrmWalletRepository(
      setupEm,
    );

    const wallet = Wallet.open(walletId, playerId, 'BRL');

    await setupRepository.save(wallet);

    // 2. Adiciona R$ 100,00 para preparar o teste.
    // Este crédito é apenas um dado de teste.
    const setupService = new WalletTransactionService(
      orm.em.fork(),
    );

    await setupService.credit(
      walletId,
      Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    );

    // 3. Cria duas operações com EntityManagers diferentes.
    const serviceA = new WalletTransactionService(
      orm.em.fork(),
    );

    const serviceB = new WalletTransactionService(
      orm.em.fork(),
    );

    // 4. Dispara as duas operações concorrentemente.
    const results = await Promise.allSettled([
      serviceA.debit(
        walletId,
        Money.from({
          amount: '70.00',
          currency: 'BRL',
        }),
      ),
      serviceB.debit(
        walletId,
        Money.from({
          amount: '50.00',
          currency: 'BRL',
        }),
      ),
    ]);

    // 5. Uma operação deve ser aceita e outra rejeitada.
    const successful = results.filter(
      (result) => result.status === 'fulfilled',
    );

    const rejected = results.filter(
      (result) => result.status === 'rejected',
    );

    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expect(
      (rejected[0] as PromiseRejectedResult).reason.message,
    ).toBe('INSUFFICIENT_FUNDS');

    // 6. Consulta o saldo realmente persistido no PostgreSQL.
    const verificationRepository = new MikroOrmWalletRepository(
      orm.em.fork(),
    );

    const persistedWallet = await verificationRepository.findById(
      walletId,
    );

    expect(persistedWallet).not.toBeNull();

    const finalBalance = persistedWallet!.balance.toJSON().amount;

    expect(['30.00', '50.00']).toContain(finalBalance);

    // Versão 1: abertura
    // Versão 2: crédito inicial
    // Versão 3: único débito aprovado
    expect(persistedWallet?.version).toBe(3);
  });
});