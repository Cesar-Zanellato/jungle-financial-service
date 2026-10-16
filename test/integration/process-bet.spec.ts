import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import {
  ProcessBetUseCase,
  type ProcessBetInput,
  type ProcessBetResult,
} from '../../src/application/use-cases/process-bet.use-case.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';

describe('ProcessBetUseCase - PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  async function prepareWallet(): Promise<{
    walletId: string;
    playerId: string;
  }> {
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
  ): ProcessBetInput {
    return {
      walletId,
      playerId,
      providerId: `provider-${randomUUID()}`,
      externalTransactionId: `bet-${randomUUID()}`,
      idempotencyKey: randomUUID(),
      payloadHash: 'a'.repeat(64),
      roundId: 'round-001',
      gameId: 'game-001',
      amount: '30.00',
      currency: 'BRL',
    };
  }

  test('BET válida deve debitar carteira e registrar ledger', async () => {
    const { walletId, playerId } = await prepareWallet();
    const input = makeInput(walletId, playerId);

    const useCase = new ProcessBetUseCase(orm.em.fork());

    const result = await useCase.execute(input);

    expect(result.status).toBe('PROCESSED');
    expect(result.balance).toBe('70.00');
    expect(result.idempotentReplay).toBe(false);

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('70.00');
    expect(wallet?.version).toBe(3);

    const transaction =
      await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      ).findById(result.transactionId);

    expect(transaction?.status).toBe('PROCESSED');
    expect(transaction?.kind).toBe('BET');

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(result.transactionId);

    expect(ledger?.direction).toBe('DEBIT');
    expect(ledger?.money.toJSON().amount).toBe('30.00');
    expect(ledger?.balanceBefore.toJSON().amount).toBe('100.00');
    expect(ledger?.balanceAfter.toJSON().amount).toBe('70.00');
  });

  test('BET com saldo insuficiente deve registrar REJECTED', async () => {
    const { walletId, playerId } = await prepareWallet();

    const input = {
        ...makeInput(walletId, playerId),
        amount: '150.00',
    };

    const useCase = new ProcessBetUseCase(orm.em.fork());

    const result = await useCase.execute(input);

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(result.balance).toBe('100.00');
    expect(result.idempotentReplay).toBe(false);

    const wallet = await new MikroOrmWalletRepository(
        orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('100.00');
    expect(wallet?.version).toBe(2);

    const transactions =
        new MikroOrmWagerTransactionRepository(orm.em.fork());

    const savedTransaction =
        await transactions.findByProviderAndExternalId(
        input.providerId,
        input.externalTransactionId,
        );

    expect(savedTransaction).not.toBeNull();
    expect(savedTransaction?.status).toBe('REJECTED');
    expect(savedTransaction?.failureCode).toBe('INSUFFICIENT_FUNDS');

    const ledger =
        await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
        ).findByTransactionId(result.transactionId);

    expect(ledger).toBeNull();
  });

  test('BET repetida não deve debitar novamente', async () => {
    const { walletId, playerId } = await prepareWallet();
    const input = makeInput(walletId, playerId);

    const first = await new ProcessBetUseCase(
      orm.em.fork(),
    ).execute(input);

    const second = await new ProcessBetUseCase(
      orm.em.fork(),
    ).execute(input);

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('70.00');
    expect(wallet?.version).toBe(3);
  });

    test('duas BETs simultâneas não devem gastar o mesmo saldo', async () => {
    const { walletId, playerId } = await prepareWallet();

    const firstInput = {
        ...makeInput(walletId, playerId),
        amount: '70.00',
    };

    const secondInput = {
        ...makeInput(walletId, playerId),
        amount: '50.00',
    };

    const results = await Promise.allSettled([
        new ProcessBetUseCase(orm.em.fork()).execute(firstInput),
        new ProcessBetUseCase(orm.em.fork()).execute(secondInput),
    ]);

    // Nenhuma operação deve falhar por erro técnico.
    const failedPromises = results.filter(
        (result) => result.status === 'rejected',
    );

    expect(failedPromises).toHaveLength(0);

    // Recuperamos os resultados financeiros.
    const completed = results
        .filter(
        (result): result is PromiseFulfilledResult<ProcessBetResult> =>
            result.status === 'fulfilled',
        )
        .map((result) => result.value);

    expect(completed).toHaveLength(2);

    const processed = completed.filter(
        (result) => result.status === 'PROCESSED',
    );

    const rejected = completed.filter(
        (result) => result.status === 'REJECTED',
    );

    // Apenas uma aposta pode ser aprovada.
    expect(processed).toHaveLength(1);

    // A outra deve ser rejeitada por saldo insuficiente.
    expect(rejected).toHaveLength(1);

    expect(rejected[0]?.failureCode).toBe('INSUFFICIENT_FUNDS');

    const wallet = await new MikroOrmWalletRepository(
        orm.em.fork(),
    ).findById(walletId);

    if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
    }

    // O saldo depende de qual aposta conseguiu o bloqueio primeiro.
    expect(['30.00', '50.00']).toContain(
        wallet.balance.toJSON().amount,
    );

    // A carteira recebeu crédito inicial e apenas um débito.
    expect(wallet.version).toBe(3);

    const transactionRepository =
        new MikroOrmWagerTransactionRepository(orm.em.fork());

    const ledgerRepository =
        new MikroOrmWalletLedgerRepository(orm.em.fork());

    // Verificamos se ambas as transações foram persistidas.
    for (const result of completed) {
        const transaction = await transactionRepository.findById(
        result.transactionId,
        );

        expect(transaction?.status).toBe(result.status);

        const ledger = await ledgerRepository.findByTransactionId(
        result.transactionId,
        );

        if (result.status === 'PROCESSED') {
        expect(ledger?.direction).toBe('DEBIT');
        } else {
        expect(ledger).toBeNull();
        }
    }
  });

  test('BET rejeitada não deve ser processada novamente', async () => {
    const { walletId, playerId } = await prepareWallet();

    const input = {
        ...makeInput(walletId, playerId),
        amount: '150.00',
    };

    const first = await new ProcessBetUseCase(
        orm.em.fork(),
    ).execute(input);

    expect(first.status).toBe('REJECTED');

    // Mesmo que o jogador receba saldo depois,
    // a aposta rejeitada não pode ser reprocessada.
    const walletRepository =
        new MikroOrmWalletRepository(orm.em.fork());

    const wallet = await walletRepository.findById(walletId);

    if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
    }

    wallet.credit(
        Money.from({
        amount: '100.00',
        currency: 'BRL',
        }),
    );

    await walletRepository.save(wallet);

    const second = await new ProcessBetUseCase(
        orm.em.fork(),
    ).execute(input);

    expect(second.status).toBe('REJECTED');
    expect(second.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    const finalWallet = await new MikroOrmWalletRepository(
        orm.em.fork(),
    ).findById(walletId);

    expect(finalWallet?.balance.toJSON().amount).toBe('200.00');

    const ledger = await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
    ).findByTransactionId(first.transactionId);

    expect(ledger).toBeNull();
  });

  test('BET idêntica concorrente deve debitar apenas uma vez', async () => {
    const { walletId, playerId } = await prepareWallet();

    const input = {
        ...makeInput(walletId, playerId),
        amount: '30.00',
    };

    const results = await Promise.allSettled([
        new ProcessBetUseCase(orm.em.fork()).execute(input),
        new ProcessBetUseCase(orm.em.fork()).execute(input),
    ]);

    const failures = results.filter(
        (result) => result.status === 'rejected',
    );

    expect(failures).toHaveLength(0);

    const completed = results
        .filter(
        (result): result is PromiseFulfilledResult<ProcessBetResult> =>
            result.status === 'fulfilled',
        )
        .map((result) => result.value);

    expect(completed).toHaveLength(2);

    // As duas chamadas devem representar a mesma transação.
    expect(completed[0]?.transactionId).toBe(
        completed[1]?.transactionId,
    );

    expect(completed[0]?.status).toBe('PROCESSED');
    expect(completed[1]?.status).toBe('PROCESSED');

    // Uma chamada processa; a outra recupera o resultado.
    const newOperations = completed.filter(
        (result) => !result.idempotentReplay,
    );

    const replays = completed.filter(
        (result) => result.idempotentReplay,
    );

    expect(newOperations).toHaveLength(1);
    expect(replays).toHaveLength(1);

    const wallet = await new MikroOrmWalletRepository(
        orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('70.00');
    expect(wallet?.version).toBe(3);

    const ledger = await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
    ).findByTransactionId(completed[0]!.transactionId);

    expect(ledger?.direction).toBe('DEBIT');
    expect(ledger?.money.toJSON().amount).toBe('30.00');
  });

});