import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case.js';
import { ProcessWinUseCase } from '../../src/application/use-cases/process-win.use-case.js';
import { ProcessRefundUseCase } from '../../src/application/use-cases/process-refund.use-case.js';
import {
  ProcessRollbackUseCase,
  type ProcessRollbackInput,
} from '../../src/application/use-cases/process-rollback.use-case.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';

describe('ProcessRollbackUseCase - PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  async function prepareWallet() {
    const walletId = randomUUID();
    const playerId = `player-${randomUUID()}`;
    const providerId = `provider-${randomUUID()}`;

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

    return { walletId, playerId, providerId };
  }

  function makeInput(
    context: Awaited<ReturnType<typeof prepareWallet>>,
    externalTransactionId: string,
    amount = '30.00',
  ) {
    return {
      ...context,
      externalTransactionId,
      idempotencyKey: randomUUID(),
      payloadHash: 'a'.repeat(64),
      roundId: 'round-001',
      gameId: 'game-001',
      amount,
      currency: 'BRL',
    };
  }

  function makeRollback(
    context: Awaited<ReturnType<typeof prepareWallet>>,
    referenceExternalTransactionId: string,
    amount = '30.00',
  ): ProcessRollbackInput {
    return {
      ...makeInput(
        context,
        `rollback-${randomUUID()}`,
        amount,
      ),
      payloadHash: 'r'.repeat(64),
      referenceExternalTransactionId,
    };
  }

  test('ROLLBACK de BET deve devolver o valor debitado', async () => {
    const context = await prepareWallet();
    const betExternalId = `bet-${randomUUID()}`;

    await new ProcessBetUseCase(orm.em.fork()).execute(
      makeInput(context, betExternalId),
    );

    const result = await new ProcessRollbackUseCase(
      orm.em.fork(),
    ).execute(makeRollback(context, betExternalId));

    expect(result.status).toBe('PROCESSED');
    expect(result.balance).toBe('100.00');

    const transaction =
      await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      ).findById(result.transactionId);

    expect(transaction?.kind).toBe('ROLLBACK');
    expect(transaction?.status).toBe('PROCESSED');

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(result.transactionId);

    expect(ledger?.direction).toBe('CREDIT');
    expect(ledger?.money.toJSON().amount).toBe('30.00');
  });

  test('ROLLBACK de WIN deve debitar o valor creditado', async () => {
    const context = await prepareWallet();
    const winExternalId = `win-${randomUUID()}`;

    await new ProcessWinUseCase(orm.em.fork()).execute(
      makeInput(context, winExternalId),
    );

    const result = await new ProcessRollbackUseCase(
      orm.em.fork(),
    ).execute(makeRollback(context, winExternalId));

    expect(result.status).toBe('PROCESSED');
    expect(result.balance).toBe('100.00');

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(result.transactionId);

    expect(ledger?.direction).toBe('DEBIT');
  });

  test('ROLLBACK de REFUND deve desfazer o estorno', async () => {
    const context = await prepareWallet();
    const betExternalId = `bet-${randomUUID()}`;
    const refundExternalId = `refund-${randomUUID()}`;

    await new ProcessBetUseCase(orm.em.fork()).execute(
      makeInput(context, betExternalId),
    );

    const refund = await new ProcessRefundUseCase(
      orm.em.fork(),
    ).execute({
      ...makeInput(context, refundExternalId),
      payloadHash: 'f'.repeat(64),
      referenceExternalTransactionId: betExternalId,
    });

    expect(refund.status).toBe('PROCESSED');

    const result = await new ProcessRollbackUseCase(
      orm.em.fork(),
    ).execute(makeRollback(context, refundExternalId));

    expect(result.status).toBe('PROCESSED');
    expect(result.balance).toBe('70.00');

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(result.transactionId);

    expect(ledger?.direction).toBe('DEBIT');
  });

  test('ROLLBACK repetido não deve alterar o saldo novamente', async () => {
    const context = await prepareWallet();
    const betExternalId = `bet-${randomUUID()}`;

    await new ProcessBetUseCase(orm.em.fork()).execute(
      makeInput(context, betExternalId),
    );

    const input = makeRollback(context, betExternalId);

    const useCase = new ProcessRollbackUseCase(
      orm.em.fork(),
    );

    const first = await useCase.execute(input);
    const second = await useCase.execute(input);

    expect(first.status).toBe('PROCESSED');
    expect(second.status).toBe('PROCESSED');
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(context.walletId);

    expect(wallet?.balance.toJSON().amount).toBe('100.00');
    expect(wallet?.version).toBe(4);
  });

  test('ROLLBACK de WIN deve rejeitar saldo insuficiente', async () => {
    const context = await prepareWallet();
    const winExternalId = `win-${randomUUID()}`;

    // WIN credita R$ 30,00: saldo = R$ 130,00.
    await new ProcessWinUseCase(orm.em.fork()).execute(
      makeInput(context, winExternalId),
    );

    // BET consome R$ 120,00: saldo = R$ 10,00.
    await new ProcessBetUseCase(orm.em.fork()).execute(
      makeInput(
        context,
        `bet-${randomUUID()}`,
        '120.00',
      ),
    );

    const result = await new ProcessRollbackUseCase(
      orm.em.fork(),
    ).execute(makeRollback(context, winExternalId));

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(result.balance).toBe('10.00');

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(context.walletId);

    expect(wallet?.balance.toJSON().amount).toBe('10.00');

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(result.transactionId);

    expect(ledger).toBeNull();
  });
});