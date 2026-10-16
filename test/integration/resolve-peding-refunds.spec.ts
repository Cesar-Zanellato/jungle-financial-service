import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case.js';
import { ProcessRefundUseCase } from '../../src/application/use-cases/process-refund.use-case.js';
import { ResolvePendingRefundsUseCase } from '../../src/application/use-cases/resolve-pending-refunds.use-case.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';

describe('ResolvePendingRefundsUseCase - PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  test('deve recuperar REFUND quando a BET original chegar', async () => {
    const walletId = randomUUID();
    const playerId = `player-${randomUUID()}`;
    const providerId = `provider-${randomUUID()}`;
    const betExternalId = `bet-${randomUUID()}`;

    // 1. Criar carteira com R$ 100,00.
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

    // 2. REFUND chega antes da BET.
    const refund = await new ProcessRefundUseCase(
      orm.em.fork(),
    ).execute({
      walletId,
      playerId,
      providerId,
      externalTransactionId: `refund-${randomUUID()}`,
      idempotencyKey: randomUUID(),
      payloadHash: 'f'.repeat(64),
      roundId: 'round-001',
      gameId: 'game-001',
      amount: '30.00',
      currency: 'BRL',
      referenceExternalTransactionId: betExternalId,
    });

    expect(refund.status).toBe('PENDING_REFERENCE');
    expect(refund.balance).toBe('100.00');

    // 3. A BET original chega posteriormente.
    const bet = await new ProcessBetUseCase(
      orm.em.fork(),
    ).execute({
      walletId,
      playerId,
      providerId,
      externalTransactionId: betExternalId,
      idempotencyKey: randomUUID(),
      payloadHash: 'a'.repeat(64),
      roundId: 'round-001',
      gameId: 'game-001',
      amount: '30.00',
      currency: 'BRL',
    });

    expect(bet.status).toBe('PROCESSED');
    expect(bet.balance).toBe('70.00');

    // 4. Recuperar o REFUND pendente.
    const resolver = new ResolvePendingRefundsUseCase(
      orm.em.fork(),
    );

    const result = await resolver.execute({
      providerId,
      referenceExternalTransactionId: betExternalId,
    });

    expect(result.processed).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.skipped).toBe(0);

    // 5. Conferir saldo final.
    const updatedWallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(updatedWallet?.balance.toJSON().amount).toBe(
      '100.00',
    );

    expect(updatedWallet?.version).toBe(4);

    // 6. Conferir status e referência do REFUND.
    const updatedRefund =
      await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      ).findById(refund.transactionId);

    expect(updatedRefund?.status).toBe('PROCESSED');

    expect(updatedRefund?.referenceTransactionId).toBe(
      bet.transactionId,
    );

    // 7. Conferir lançamento no ledger.
    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(refund.transactionId);

    expect(ledger?.direction).toBe('CREDIT');

    expect(ledger?.money.toJSON().amount).toBe('30.00');

    expect(ledger?.balanceBefore.toJSON().amount).toBe(
      '70.00',
    );

    expect(ledger?.balanceAfter.toJSON().amount).toBe(
      '100.00',
    );
  });
  
  test('deve processar apenas um de dois REFUNDs pendentes para a mesma BET', async () => {
    const walletId = randomUUID();
    const playerId = `player-${randomUUID()}`;
    const providerId = `provider-${randomUUID()}`;
    const betExternalId = `bet-${randomUUID()}`;

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

    const refunds = new ProcessRefundUseCase(orm.em.fork());

    const makeRefund = () => ({
        walletId,
        playerId,
        providerId,
        externalTransactionId: `refund-${randomUUID()}`,
        idempotencyKey: randomUUID(),
        payloadHash: 'f'.repeat(64),
        roundId: 'round-001',
        gameId: 'game-001',
        amount: '30.00',
        currency: 'BRL',
        referenceExternalTransactionId: betExternalId,
    });

    const first = await refunds.execute(makeRefund());
    const second = await refunds.execute(makeRefund());

    expect(first.status).toBe('PENDING_REFERENCE');
    expect(second.status).toBe('PENDING_REFERENCE');

    const bet = await new ProcessBetUseCase(
        orm.em.fork(),
    ).execute({
        walletId,
        playerId,
        providerId,
        externalTransactionId: betExternalId,
        idempotencyKey: randomUUID(),
        payloadHash: 'a'.repeat(64),
        roundId: 'round-001',
        gameId: 'game-001',
        amount: '30.00',
        currency: 'BRL',
    });

    expect(bet.status).toBe('PROCESSED');

    const result = await new ResolvePendingRefundsUseCase(
        orm.em.fork(),
    ).execute({
        providerId,
        referenceExternalTransactionId: betExternalId,
    });

    expect(result.processed).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.skipped).toBe(0);

    const repository = new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
    );

    const firstTransaction = await repository.findById(
        first.transactionId,
    );

    const secondTransaction = await repository.findById(
        second.transactionId,
    );

    const statuses = [
        firstTransaction?.status,
        secondTransaction?.status,
    ].sort();

    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

    const updatedWallet = await new MikroOrmWalletRepository(
        orm.em.fork(),
    ).findById(walletId);

    expect(updatedWallet?.balance.toJSON().amount).toBe('100.00');
    expect(updatedWallet?.version).toBe(4);

    const ledgerRepository = new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
    );

    const firstLedger = await ledgerRepository.findByTransactionId(
        first.transactionId,
    );

    const secondLedger = await ledgerRepository.findByTransactionId(
        second.transactionId,
    );

    const createdLedgers = [firstLedger, secondLedger].filter(
        (entry) => entry !== null,
    );

    expect(createdLedgers).toHaveLength(1);
    expect(createdLedgers[0]?.direction).toBe('CREDIT');
  });

});