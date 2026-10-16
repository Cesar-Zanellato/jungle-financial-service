import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';

describe('ProcessBetUseCase - Transactional Outbox', () => {
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

    return {
      walletId,
      playerId,
      providerId,
    };
  }

  function makeBet(
    context: Awaited<ReturnType<typeof prepareWallet>>,
    amount = '30.00',
  ) {
    return {
      ...context,
      externalTransactionId: `bet-${randomUUID()}`,
      idempotencyKey: randomUUID(),
      payloadHash: 'a'.repeat(64),
      roundId: 'round-001',
      gameId: 'game-001',
      amount,
      currency: 'BRL',
    };
  }

  async function getEvents(transactionId: string) {
    return orm.em.fork().execute<
      Array<{
        id: string;
        event_type: string;
        aggregate_id: string;
        payload: Record<string, unknown>;
      }>
    >(
      `
        SELECT
          id,
          event_type,
          aggregate_id,
          payload
        FROM outbox_events
        WHERE payload->>'transactionId' = ?
        ORDER BY created_at, id
      `,
      [transactionId],
    );
  }

  test('BET processada deve criar dois eventos', async () => {
    const context = await prepareWallet();

    const result = await new ProcessBetUseCase(
      orm.em.fork(),
    ).execute(makeBet(context));

    expect(result.status).toBe('PROCESSED');
    expect(result.balance).toBe('70.00');

    const events = await getEvents(result.transactionId);

    expect(events).toHaveLength(2);

    const types = events
      .map((event) => event.event_type)
      .sort();

    expect(types).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    expect(
      events.every((event) => event.payload.transactionId === result.transactionId),
    ).toBe(true);
  });

  test('BET rejeitada deve criar apenas um evento', async () => {
    const context = await prepareWallet();

    const result = await new ProcessBetUseCase(
      orm.em.fork(),
    ).execute(makeBet(context, '150.00'));

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');

    const events = await getEvents(result.transactionId);

    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe(
      'WagerTransactionRejected',
    );

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(result.transactionId);

    expect(ledger).toBeNull();
  });

  test('repetição idempotente não deve criar novos eventos', async () => {
    const context = await prepareWallet();
    const input = makeBet(context);

    const useCase = new ProcessBetUseCase(
      orm.em.fork(),
    );

    const first = await useCase.execute(input);
    const second = await useCase.execute(input);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    const events = await getEvents(first.transactionId);

    expect(events).toHaveLength(2);
  });

  test('falha na Outbox deve reverter a BET inteira', async () => {
    const context = await prepareWallet();
    const input = makeBet(context);

    // Força a falha na segunda inserção da Outbox.
    // A constraint permite apenas tipos conhecidos.
    //
    // O trigger temporário é criado dentro da mesma
    // transação e removido automaticamente no rollback.
    //
    // Usamos uma transação externa para manter o teste
    // isolado dos demais cenários.

    const em = orm.em.fork();

    await expect(
      em.transactional(async (tx) => {
        await tx.execute(`
          CREATE OR REPLACE FUNCTION
            test_reject_outbox_insert()
          RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'OUTBOX_TEST_FAILURE';
          END;
          $$ LANGUAGE plpgsql;
        `);

        await tx.execute(`
          CREATE TRIGGER trg_test_reject_outbox
          BEFORE INSERT ON outbox_events
          FOR EACH ROW
          EXECUTE FUNCTION test_reject_outbox_insert();
        `);

        await new ProcessBetUseCase(tx).execute(input);
      }),
    ).rejects.toThrow();

    // O saldo permanece inalterado.
    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(context.walletId);

    expect(wallet?.balance.toJSON().amount).toBe('100.00');
    expect(wallet?.version).toBe(2);

    // A transação não pode existir após o rollback.
    const transaction =
      await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      ).findByProviderAndExternalId(
        context.providerId,
        input.externalTransactionId,
      );

    expect(transaction).toBeNull();

    // Nenhum evento pode ter sobrevivido à falha.
    const rows = await orm.em.fork().execute<
      Array<{ count: string }>
    >(
      `
        SELECT COUNT(*)::text AS count
        FROM outbox_events
        WHERE payload->>'externalTransactionId' = ?
      `,
      [input.externalTransactionId],
    );

    expect(rows[0]?.count).toBe('0');
  });
});