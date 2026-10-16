import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import {
  ProcessLossUseCase,
  type ProcessLossInput,
} from '../../src/application/use-cases/process-loss.use-case.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';

describe('ProcessLossUseCase - PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  async function prepareWallet() {
    const walletId = randomUUID();
    const playerId = `player-${randomUUID()}`;

    const wallet = Wallet.open(
      walletId,
      playerId,
      'BRL',
    );

    wallet.credit(
      Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    );

    await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).save(wallet);

    return { walletId, playerId };
  }

  function makeInput(
    walletId: string,
    playerId: string,
  ): ProcessLossInput {
    return {
      walletId,
      playerId,
      providerId: `provider-${randomUUID()}`,
      externalTransactionId: `loss-${randomUUID()}`,
      idempotencyKey: randomUUID(),
      payloadHash: 'd'.repeat(64),
      roundId: 'round-001',
      gameId: 'game-001',
      amount: '30.00',
      currency: 'BRL',
    };
  }

  test('LOSS deve ser processada sem alterar saldo ou ledger', async () => {
    const { walletId, playerId } = await prepareWallet();
    const input = makeInput(walletId, playerId);

    const result = await new ProcessLossUseCase(
      orm.em.fork(),
    ).execute(input);

    expect(result.status).toBe('PROCESSED');
    expect(result.balance).toBe('100.00');
    expect(result.idempotentReplay).toBe(false);

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('100.00');
    expect(wallet?.version).toBe(2);

    const transaction =
      await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      ).findById(result.transactionId);

    expect(transaction?.kind).toBe('LOSS');
    expect(transaction?.status).toBe('PROCESSED');

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(result.transactionId);

    expect(ledger).toBeNull();
  });

  test('LOSS repetida não deve criar outra transação', async () => {
    const { walletId, playerId } = await prepareWallet();
    const input = makeInput(walletId, playerId);

    const first = await new ProcessLossUseCase(
      orm.em.fork(),
    ).execute(input);

    const second = await new ProcessLossUseCase(
      orm.em.fork(),
    ).execute(input);

    expect(first.status).toBe('PROCESSED');
    expect(second.status).toBe('PROCESSED');

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);

    expect(second.transactionId).toBe(first.transactionId);

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('100.00');
    expect(wallet?.version).toBe(2);

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(first.transactionId);

    expect(ledger).toBeNull();
  });

  test('duas LOSSs simultâneas devem ser registradas sem movimentar saldo', async () => {
    const { walletId, playerId } = await prepareWallet();

    const firstInput = makeInput(walletId, playerId);
    const secondInput = makeInput(walletId, playerId);

    const results = await Promise.allSettled([
      new ProcessLossUseCase(orm.em.fork()).execute(firstInput),
      new ProcessLossUseCase(orm.em.fork()).execute(secondInput),
    ]);

    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(0);

    const completed = results
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<ProcessLossUseCase['execute']>>
        > => result.status === 'fulfilled',
      )
      .map((result) => result.value);

    expect(completed).toHaveLength(2);

    expect(completed[0]?.status).toBe('PROCESSED');
    expect(completed[1]?.status).toBe('PROCESSED');

    expect(completed[0]?.transactionId).not.toBe(
      completed[1]?.transactionId,
    );

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('100.00');
    expect(wallet?.version).toBe(2);

    const transactionRepository =
      new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      );

    const ledgerRepository =
      new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      );

    for (const result of completed) {
      const transaction = await transactionRepository.findById(
        result.transactionId,
      );

      expect(transaction?.kind).toBe('LOSS');
      expect(transaction?.status).toBe('PROCESSED');

      const ledger = await ledgerRepository.findByTransactionId(
        result.transactionId,
      );

      expect(ledger).toBeNull();
    }
  });
});