import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';

import testConfig from '../../src/mikro-orm.test.config.js';
import { WalletOrmEntity } from '../../src/infrastructure/persistence/entities/wallet.orm-entity.js';

import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import { WalletLedgerEntry } from '../../src/domain/entities/wallet-ledger-entry.js';

import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';

describe('Ledger - Atomicidade PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(testConfig);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  test('deve desfazer o débito quando o ledger falhar', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Criamos uma carteira de teste com R$ 100,00.
    const wallet = Wallet.open(walletId, playerId, 'BRL');

    wallet.credit(
      Money.from({ amount: '100.00', currency: 'BRL' }),
    );

    const setupEm = orm.em.fork();

    try {
      const repository = new MikroOrmWalletRepository(setupEm);
      await repository.save(wallet);
    } finally {
      setupEm.clear();
    }

    const em = orm.em.fork();

    // A transação deve falhar e desfazer todas as alterações.
    await expect(
        em.transactional(async (transactionEm) => {
        const walletRepository =
          new MikroOrmWalletRepository(transactionEm);

        const ledgerRepository =
          new MikroOrmWalletLedgerRepository(transactionEm);

        const currentWallet =
          await walletRepository.findByIdForUpdate(walletId);

        if (!currentWallet) {
          throw new Error('WALLET_NOT_FOUND');
        }

        const amount = Money.from({
          amount: '30.00',
          currency: 'BRL',
        });

        const balanceBefore = currentWallet.balance;

        currentWallet.debit(amount);

        await walletRepository.save(currentWallet);

        const ledger = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId,
          transactionId: randomUUID(),
          direction: 'DEBIT',
          money: amount,
          balanceBefore,
          balanceAfter: currentWallet.balance,
          createdAt: new Date(),
        });

        await ledgerRepository.save(ledger);

        // Simula uma falha após as gravações.
        throw new Error('SIMULATED_FAILURE');
      }),
    ).rejects.toThrow('SIMULATED_FAILURE');

    // Uma nova consulta verifica o estado persistido.
    const verificationEm = orm.em.fork();

    try {
      const savedWallet = await verificationEm.findOne(
        WalletOrmEntity,
        { id: walletId },
      );

      expect(savedWallet).not.toBeNull();
      expect(savedWallet?.balance).toBe('100.00');
      expect(savedWallet?.version).toBe(2);

      const ledgerRows = await verificationEm.execute<
        Array<{ id: string }>
      >(
        'SELECT id FROM ledger_entries WHERE wallet_id = ?',
        [walletId],
      );

      expect(ledgerRows).toHaveLength(0);
    } finally {
      verificationEm.clear();
    }
  });

  test('deve confirmar carteira e ledger na mesma transação', async () => {
  const walletId = randomUUID();
  const playerId = randomUUID();
  const transactionId = randomUUID();

  const wallet = Wallet.open(walletId, playerId, 'BRL');

  wallet.credit(
    Money.from({
      amount: '100.00',
      currency: 'BRL',
    }),
  );

  // Prepara a carteira inicial no banco de testes.
  const setupEm = orm.em.fork();

  await new MikroOrmWalletRepository(setupEm).save(wallet);

  // Executa a operação financeira em uma única transação.
  const em = orm.em.fork();

  await em.transactional(async (transactionEm) => {
        const walletRepository =
        new MikroOrmWalletRepository(transactionEm);

        const ledgerRepository =
        new MikroOrmWalletLedgerRepository(transactionEm);

        const currentWallet =
        await walletRepository.findByIdForUpdate(walletId);

        if (!currentWallet) {
        throw new Error('WALLET_NOT_FOUND');
        }

        const amount = Money.from({
        amount: '30.00',
        currency: 'BRL',
        });

        const balanceBefore = currentWallet.balance;

        currentWallet.debit(amount);

        const ledger = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId,
        transactionId,
        direction: 'DEBIT',
        money: amount,
        balanceBefore,
        balanceAfter: currentWallet.balance,
        createdAt: new Date(),
        });

        await walletRepository.save(currentWallet);
        await ledgerRepository.save(ledger);
    });

    // Verifica os dados em um novo EntityManager,
    // evitando depender de objetos mantidos em memória.
    const verificationEm = orm.em.fork();

    const savedWallet = await verificationEm.findOne(
        WalletOrmEntity,
        { id: walletId },
    );

    expect(savedWallet).not.toBeNull();
    expect(savedWallet?.balance).toBe('70.00');
    expect(savedWallet?.version).toBe(3);

    const ledgerRepository =
        new MikroOrmWalletLedgerRepository(verificationEm);

    const savedLedger =
        await ledgerRepository.findByTransactionId(transactionId);

    expect(savedLedger).not.toBeNull();
    expect(savedLedger?.walletId).toBe(walletId);
    expect(savedLedger?.direction).toBe('DEBIT');
    expect(savedLedger?.money.toJSON().amount).toBe('30.00');
    expect(savedLedger?.balanceBefore.toJSON().amount).toBe('100.00');
    expect(savedLedger?.balanceAfter.toJSON().amount).toBe('70.00');
    });
});