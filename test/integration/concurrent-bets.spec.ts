import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case.js';

describe('BET - Concorrência PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close();
    }
  });

  test('duas BETs simultâneas não podem gastar o mesmo saldo', async () => {
    const walletId = randomUUID();
    const playerId = `player-${randomUUID()}`;
    const providerId = `provider-${randomUUID()}`;

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

    const makeBet = () => ({
      walletId,
      playerId,
      providerId,
      externalTransactionId: `bet-${randomUUID()}`,
      idempotencyKey: randomUUID(),
      payloadHash: randomUUID().replaceAll('-', '').repeat(2),
      roundId: 'round-concurrency',
      gameId: 'game-concurrency',
      amount: '80.00',
      currency: 'BRL',
    });

    // EntityManagers independentes simulam
    // requisições atendidas por instâncias diferentes.
    const bet1 = new ProcessBetUseCase(orm.em.fork());
    const bet2 = new ProcessBetUseCase(orm.em.fork());

    const [result1, result2] = await Promise.all([
      bet1.execute(makeBet()),
      bet2.execute(makeBet()),
    ]);

    const statuses = [
      result1.status,
      result2.status,
    ].sort();

    expect(statuses).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);

    const updatedWallet =
      await new MikroOrmWalletRepository(
        orm.em.fork(),
      ).findById(walletId);

    expect(
      updatedWallet?.balance.toJSON().amount,
    ).toBe('20.00');

    expect(updatedWallet?.version).toBe(3);

    const ledgerRepository =
      new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      );

    const ledger1 =
      await ledgerRepository.findByTransactionId(
        result1.transactionId,
      );

    const ledger2 =
      await ledgerRepository.findByTransactionId(
        result2.transactionId,
      );

    const createdLedgers = [
      ledger1,
      ledger2,
    ].filter((entry) => entry !== null);

    expect(createdLedgers).toHaveLength(1);

    expect(createdLedgers[0]?.direction).toBe(
      'DEBIT',
    );

    expect(
      createdLedgers[0]?.money.toJSON().amount,
    ).toBe('80.00');
  });

  
  test('duas BETs simultâneas com a mesma chave devem ser idempotentes', async () => {
    const walletId = randomUUID();
    const playerId = `player-${randomUUID()}`;
    const providerId = `provider-${randomUUID()}`;

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

    // As duas requisições representam exatamente
    // a mesma operação enviada pelo provedor.
    const input = {
        walletId,
        playerId,
        providerId,
        externalTransactionId: `bet-${randomUUID()}`,
        idempotencyKey: randomUUID(),
        payloadHash: 'a'.repeat(64),
        roundId: 'round-idempotency',
        gameId: 'game-idempotency',
        amount: '30.00',
        currency: 'BRL',
    };

    const bet1 = new ProcessBetUseCase(
        orm.em.fork(),
    );

    const bet2 = new ProcessBetUseCase(
        orm.em.fork(),
    );

    const [result1, result2] = await Promise.all([
        bet1.execute(input),
        bet2.execute(input),
    ]);

    // Ambas devem apontar para a mesma transação.
    expect(result1.transactionId).toBe(
        result2.transactionId,
    );

    expect(result1.status).toBe('PROCESSED');
    expect(result2.status).toBe('PROCESSED');

    const replayFlags = [
        result1.idempotentReplay,
        result2.idempotentReplay,
    ].sort();

    expect(replayFlags).toEqual([
        false,
        true,
    ]);

    const updatedWallet =
        await new MikroOrmWalletRepository(
        orm.em.fork(),
        ).findById(walletId);

    // A aposta deve ser debitada apenas uma vez.
    expect(
        updatedWallet?.balance.toJSON().amount,
    ).toBe('70.00');

    expect(updatedWallet?.version).toBe(3);

    const ledgerRepository =
        new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
        );

    const ledgerEntry =
        await ledgerRepository.findByTransactionId(
        result1.transactionId,
        );

    expect(ledgerEntry).not.toBeNull();
    expect(ledgerEntry?.direction).toBe('DEBIT');

    expect(
        ledgerEntry?.money.toJSON().amount,
    ).toBe('30.00');
  });

});