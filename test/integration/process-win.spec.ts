import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import {
  ProcessWinUseCase,
  type ProcessWinInput,
} from '../../src/application/use-cases/process-win.use-case.js'
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';

describe('ProcessWinUseCase - PostgreSQL', () => {
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

    const wallet = Wallet.open(walletId, playerId, 'BRL');

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
  ): ProcessWinInput {
    return {
      walletId,
      playerId,
      providerId: `provider-${randomUUID()}`,
      externalTransactionId: `win-${randomUUID()}`,
      idempotencyKey: randomUUID(),
      payloadHash: 'b'.repeat(64),
      roundId: 'round-001',
      gameId: 'game-001',
      amount: '50.00',
      currency: 'BRL',
    };
  }

  test('WIN deve creditar carteira e registrar CREDIT no ledger', async () => {
    const { walletId, playerId } = await prepareWallet();
    const input = makeInput(walletId, playerId);

    const result = await new ProcessWinUseCase(
      orm.em.fork(),
    ).execute(input);

    expect(result.status).toBe('PROCESSED');
    expect(result.balance).toBe('150.00');
    expect(result.idempotentReplay).toBe(false);

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('150.00');
    expect(wallet?.version).toBe(3);

    const transaction =
      await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      ).findById(result.transactionId);

    expect(transaction?.kind).toBe('WIN');
    expect(transaction?.status).toBe('PROCESSED');

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(result.transactionId);

    expect(ledger?.direction).toBe('CREDIT');
    expect(ledger?.money.toJSON().amount).toBe('50.00');
    expect(ledger?.balanceBefore.toJSON().amount).toBe('100.00');
    expect(ledger?.balanceAfter.toJSON().amount).toBe('150.00');
  });

  test('WIN repetida não deve creditar novamente', async () => {
    const { walletId, playerId } = await prepareWallet();
    const input = makeInput(walletId, playerId);

    const first = await new ProcessWinUseCase(
      orm.em.fork(),
    ).execute(input);

    const second = await new ProcessWinUseCase(
      orm.em.fork(),
    ).execute(input);

    expect(first.status).toBe('PROCESSED');
    expect(first.idempotentReplay).toBe(false);

    expect(second.status).toBe('PROCESSED');
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('150.00');
    expect(wallet?.version).toBe(3);

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(first.transactionId);

    expect(ledger?.direction).toBe('CREDIT');
    expect(ledger?.money.toJSON().amount).toBe('50.00');
  });

  test('duas WINs simultâneas devem preservar ambos os créditos', async () => {
    const { walletId, playerId } = await prepareWallet();

    const firstInput = {
      ...makeInput(walletId, playerId),
      amount: '30.00',
    };

    const secondInput = {
      ...makeInput(walletId, playerId),
      amount: '50.00',
    };

    const results = await Promise.allSettled([
      new ProcessWinUseCase(orm.em.fork()).execute(firstInput),
      new ProcessWinUseCase(orm.em.fork()).execute(secondInput),
    ]);

    const failures = results.filter(
      (result) => result.status === 'rejected',
    );

    expect(failures).toHaveLength(0);

    const completed = results
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<ProcessWinUseCase['execute']>>
        > => result.status === 'fulfilled',
      )
      .map((result) => result.value);

    expect(completed).toHaveLength(2);

    for (const result of completed) {
      expect(result.status).toBe('PROCESSED');
      expect(result.idempotentReplay).toBe(false);
    }

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('180.00');
    expect(wallet?.version).toBe(4);

    const ledgerRepository = new MikroOrmWalletLedgerRepository(
      orm.em.fork(),
    );

    for (const result of completed) {
      const entry = await ledgerRepository.findByTransactionId(
        result.transactionId,
      );

      expect(entry?.direction).toBe('CREDIT');
    }
  });

  test('WIN idêntica concorrente deve creditar apenas uma vez', async () => {
    const { walletId, playerId } = await prepareWallet();
    const input = makeInput(walletId, playerId);

    const results = await Promise.allSettled([
      new ProcessWinUseCase(orm.em.fork()).execute(input),
      new ProcessWinUseCase(orm.em.fork()).execute(input),
    ]);

    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(0);

    const completed = results
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<ProcessWinUseCase['execute']>>
        > => result.status === 'fulfilled',
      )
      .map((result) => result.value);

    expect(completed).toHaveLength(2);

    expect(completed[0]?.transactionId).toBe(
      completed[1]?.transactionId,
    );

    expect(
      completed.filter((result) => result.idempotentReplay),
    ).toHaveLength(1);

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('150.00');
    expect(wallet?.version).toBe(3);

    const ledger = await new MikroOrmWalletLedgerRepository(
      orm.em.fork(),
    ).findByTransactionId(completed[0]!.transactionId);

    expect(ledger?.direction).toBe('CREDIT');
    expect(ledger?.money.toJSON().amount).toBe('50.00');
  });

  test('WIN deve rejeitar reutilização da chave com payload diferente', async () => {
    const { walletId, playerId } = await prepareWallet();
    const input = makeInput(walletId, playerId);

    const first = await new ProcessWinUseCase(
      orm.em.fork(),
    ).execute(input);

    expect(first.status).toBe('PROCESSED');

    const conflictingInput = {
      ...input,
      payloadHash: 'c'.repeat(64),
      amount: '90.00',
    };

    await expect(
      new ProcessWinUseCase(orm.em.fork()).execute(conflictingInput),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('150.00');
    expect(wallet?.version).toBe(3);
  });

  test('WIN deve executar ROLLBACK se o ledger falhar', async () => {
    const { walletId, playerId } = await prepareWallet();
    const input = makeInput(walletId, playerId);

    // Guardamos o método original.
    const originalSave =
      MikroOrmWalletLedgerRepository.prototype.save;

    try {
      // Simula uma falha durante a gravação do ledger.
      MikroOrmWalletLedgerRepository.prototype.save =
        async function () {
          throw new Error('SIMULATED_LEDGER_FAILURE');
        };

      await expect(
        new ProcessWinUseCase(orm.em.fork()).execute(input),
      ).rejects.toThrow('SIMULATED_LEDGER_FAILURE');
    } finally {
      // Restauramos o método mesmo se o teste falhar.
      MikroOrmWalletLedgerRepository.prototype.save =
        originalSave;
    }

    // A carteira não pode ter recebido o crédito.
    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('100.00');
    expect(wallet?.version).toBe(2);

    // A transação WIN também deve ter sido desfeita.
    const transaction =
      await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      ).findByProviderAndExternalId(
        input.providerId,
        input.externalTransactionId,
      );

    expect(transaction).toBeNull();
  });


});