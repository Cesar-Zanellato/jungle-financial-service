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

import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';

import {
  MikroOrmLedgerRepository,
  type NewLedgerEntry,
} from '../../src/infrastructure/persistence/repositories/mikro-orm-ledger.repository.js';

describe('Ledger - PostgreSQL', () => {
  let orm: MikroORM;
  let walletId: string;

  beforeAll(async () => {
    orm = await MikroORM.init(config);

    walletId = randomUUID();

    const walletRepository = new MikroOrmWalletRepository(
      orm.em.fork(),
    );

    await walletRepository.save(
      Wallet.open(
        walletId,
        `ledger-player-${randomUUID()}`,
        'BRL',
      ),
    );
  });

  afterAll(async () => {
    if (orm) {
      await orm.close();
    }
  });

  function makeEntry(): NewLedgerEntry {
    return {
      id: randomUUID(),
      walletId,
      transactionId: randomUUID(),
      direction: 'CREDIT',
      currency: 'BRL',
      amount: '100.00',
      balanceBefore: '0.00',
      balanceAfter: '100.00',
      createdAt: new Date(),
    };
  }

  test('deve persistir e recuperar um lançamento', async () => {
    const entry = makeEntry();

    const repository = new MikroOrmLedgerRepository(
      orm.em.fork(),
    );

    await repository.append(entry);

    const verificationRepository = new MikroOrmLedgerRepository(
      orm.em.fork(),
    );

    const persisted = await verificationRepository.findById(
      entry.id,
    );

    expect(persisted).not.toBeNull();
    expect(persisted?.walletId).toBe(walletId);
    expect(persisted?.direction).toBe('CREDIT');
    expect(persisted?.amount).toBe('100.00');
    expect(persisted?.balanceAfter).toBe('100.00');
  });

  test('deve impedir lançamento duplicado', async () => {
    const entry = makeEntry();

    const repository = new MikroOrmLedgerRepository(
      orm.em.fork(),
    );

    await repository.append(entry);

    const duplicate = {
      ...entry,
      id: randomUUID(),
    };

    const duplicateRepository = new MikroOrmLedgerRepository(
      orm.em.fork(),
    );

    await expect(
      duplicateRepository.append(duplicate),
    ).rejects.toThrow();
  });

  test('deve rejeitar saldo inconsistente', async () => {
    const entry = {
      ...makeEntry(),
      balanceAfter: '999.00',
    };

    const repository = new MikroOrmLedgerRepository(
      orm.em.fork(),
    );

    await expect(
      repository.append(entry),
    ).rejects.toThrow();
  });

  test('deve impedir UPDATE no ledger', async () => {
    const entry = makeEntry();

    const repository = new MikroOrmLedgerRepository(
      orm.em.fork(),
    );

    await repository.append(entry);

    const em = orm.em.fork();

    await expect(
      em.getConnection().execute(
        `
        UPDATE ledger_entries
        SET amount = '200.00'
        WHERE id = ?
        `,
        [entry.id],
      ),
    ).rejects.toThrow(/LEDGER_IMMUTABLE/);
  });

  test('deve impedir DELETE no ledger', async () => {
    const entry = makeEntry();

    const repository = new MikroOrmLedgerRepository(
      orm.em.fork(),
    );

    await repository.append(entry);

    const em = orm.em.fork();

    await expect(
      em.getConnection().execute(
        `
        DELETE FROM ledger_entries
        WHERE id = ?
        `,
        [entry.id],
      ),
    ).rejects.toThrow(/LEDGER_IMMUTABLE/);
  });
});