import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case.js';
import {
  ProcessRefundUseCase,
  type ProcessRefundInput,
} from '../../src/application/use-cases/process-refund.use-case.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';
import {  ProcessWinUseCase } from '../../src/application/use-cases/process-win.use-case.js';

describe('ProcessRefundUseCase - PostgreSQL', () => {
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

  function makeBetInput(
    walletId: string,
    playerId: string,
    providerId: string,
    externalTransactionId: string,
  ) {
    return {
      walletId,
      playerId,
      providerId,
      externalTransactionId,
      idempotencyKey: randomUUID(),
      payloadHash: 'a'.repeat(64),
      roundId: 'round-001',
      gameId: 'game-001',
      amount: '30.00',
      currency: 'BRL',
    };
  }

  function makeRefundInput(
    walletId: string,
    playerId: string,
    providerId: string,
    referenceExternalTransactionId: string,
  ): ProcessRefundInput {
    return {
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
      referenceExternalTransactionId,
    };
  }

  test('REFUND válido deve restaurar saldo e gerar CREDIT', async () => {
    const { walletId, playerId } = await prepareWallet();
    const providerId = `provider-${randomUUID()}`;
    const betExternalId = `bet-${randomUUID()}`;

    const bet = await new ProcessBetUseCase(
      orm.em.fork(),
    ).execute(
      makeBetInput(
        walletId,
        playerId,
        providerId,
        betExternalId,
      ),
    );

    expect(bet.status).toBe('PROCESSED');
    expect(bet.balance).toBe('70.00');

    const refund = await new ProcessRefundUseCase(
      orm.em.fork(),
    ).execute(
      makeRefundInput(
        walletId,
        playerId,
        providerId,
        betExternalId,
      ),
    );

    expect(refund.status).toBe('PROCESSED');
    expect(refund.balance).toBe('100.00');
    expect(refund.idempotentReplay).toBe(false);

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('100.00');
    expect(wallet?.version).toBe(4);

    const transaction =
      await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      ).findById(refund.transactionId);

    expect(transaction?.kind).toBe('REFUND');
    expect(transaction?.status).toBe('PROCESSED');
    expect(transaction?.referenceTransactionId).toBe(
      bet.transactionId,
    );

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(refund.transactionId);

    expect(ledger?.direction).toBe('CREDIT');
    expect(ledger?.money.toJSON().amount).toBe('30.00');
    expect(ledger?.balanceBefore.toJSON().amount).toBe('70.00');
    expect(ledger?.balanceAfter.toJSON().amount).toBe('100.00');
  });

  test('REFUND repetido não deve creditar novamente', async () => {
    const { walletId, playerId } = await prepareWallet();
    const providerId = `provider-${randomUUID()}`;
    const betExternalId = `bet-${randomUUID()}`;

    await new ProcessBetUseCase(
      orm.em.fork(),
    ).execute(
      makeBetInput(
        walletId,
        playerId,
        providerId,
        betExternalId,
      ),
    );

    const input = makeRefundInput(
      walletId,
      playerId,
      providerId,
      betExternalId,
    );

    const first = await new ProcessRefundUseCase(
      orm.em.fork(),
    ).execute(input);

    const second = await new ProcessRefundUseCase(
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
    expect(wallet?.version).toBe(4);
  });

  test('REFUND sem BET original deve ficar PENDING_REFERENCE', async () => {
    const { walletId, playerId } = await prepareWallet();
    const providerId = `provider-${randomUUID()}`;

    const input = makeRefundInput(
      walletId,
      playerId,
      providerId,
      `missing-bet-${randomUUID()}`,
    );

    const result = await new ProcessRefundUseCase(
      orm.em.fork(),
    ).execute(input);

    expect(result.status).toBe('PENDING_REFERENCE');
    expect(result.balance).toBe('100.00');

    const transaction =
      await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      ).findById(result.transactionId);

    expect(transaction?.status).toBe('PENDING_REFERENCE');
    expect(transaction?.referenceTransactionId).toBeUndefined();

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('100.00');
    expect(wallet?.version).toBe(2);

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(result.transactionId);

    expect(ledger).toBeNull();
  });

  
    test('não deve permitir dois REFUNDs da mesma BET', async () => {
    const { walletId, playerId } = await prepareWallet();

    const providerId = `provider-${randomUUID()}`;
    const betExternalId = `bet-${randomUUID()}`;

    const bet = await new ProcessBetUseCase(
        orm.em.fork(),
    ).execute(
        makeBetInput(
        walletId,
        playerId,
        providerId,
        betExternalId,
        ),
    );

    expect(bet.status).toBe('PROCESSED');

    // Primeiro estorno.
    const firstRefundInput = makeRefundInput(
        walletId,
        playerId,
        providerId,
        betExternalId,
    );

    const firstRefund = await new ProcessRefundUseCase(
        orm.em.fork(),
    ).execute(firstRefundInput);

    expect(firstRefund.status).toBe('PROCESSED');
    expect(firstRefund.balance).toBe('100.00');

    // Segundo estorno da mesma BET, mas com outra
    // chave de idempotência e outro identificador externo.
    const secondRefundInput = makeRefundInput(
        walletId,
        playerId,
        providerId,
        betExternalId,
    );

    await expect(
        new ProcessRefundUseCase(orm.em.fork()).execute(
        secondRefundInput,
        ),
    ).rejects.toThrow('REFUND_ALREADY_EXISTS');

    // O saldo não pode receber um segundo crédito.
    const wallet = await new MikroOrmWalletRepository(
        orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('100.00');
    expect(wallet?.version).toBe(4);

    // A tentativa rejeitada não deve deixar
    // uma nova transação persistida.
    const secondRefund =
        await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
        ).findByProviderAndExternalId(
        providerId,
        secondRefundInput.externalTransactionId,
        );

    expect(secondRefund).toBeNull();

    // O primeiro REFUND continua registrado.
    const firstRefundTransaction =
        await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
        ).findById(firstRefund.transactionId);

    expect(firstRefundTransaction?.status).toBe('PROCESSED');

    const ledger =
        await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
        ).findByTransactionId(firstRefund.transactionId);

    expect(ledger?.direction).toBe('CREDIT');
    expect(ledger?.money.toJSON().amount).toBe('30.00');
  });

  test('REFUND com valor diferente da BET deve ser rejeitado', async () => {
    const { walletId, playerId } = await prepareWallet();

    const providerId = `provider-${randomUUID()}`;
    const betExternalId = `bet-${randomUUID()}`;

    await new ProcessBetUseCase(
      orm.em.fork(),
    ).execute(
      makeBetInput(walletId, playerId, providerId, betExternalId),
    );

    const refundInput = {
      ...makeRefundInput(
        walletId,
        playerId,
        providerId,
        betExternalId,
      ),
      amount: '20.00',
    };

    await expect(
      new ProcessRefundUseCase(orm.em.fork()).execute(refundInput),
    ).rejects.toThrow('REFUND_REFERENCE_MISMATCH');

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('70.00');
    expect(wallet?.version).toBe(3);
  });

  
  test('REFUND com rodada diferente deve ser rejeitado', async () => {
    const { walletId, playerId } = await prepareWallet();

    const providerId = `provider-${randomUUID()}`;
    const betExternalId = `bet-${randomUUID()}`;

    await new ProcessBetUseCase(
      orm.em.fork(),
    ).execute(
      makeBetInput(walletId, playerId, providerId, betExternalId),
    );

    const refundInput = {
      ...makeRefundInput(
        walletId,
        playerId,
        providerId,
        betExternalId,
      ),
      roundId: 'round-diferente',
    };

    await expect(
      new ProcessRefundUseCase(orm.em.fork()).execute(refundInput),
    ).rejects.toThrow('REFUND_REFERENCE_MISMATCH');

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('70.00');
    expect(wallet?.version).toBe(3);
  });

  test('REFUND não deve permitir referência a uma WIN', async () => {
    const { walletId, playerId } = await prepareWallet();

    const providerId = `provider-${randomUUID()}`;
    const winExternalId = `win-${randomUUID()}`;

    const win = await new ProcessWinUseCase(
      orm.em.fork(),
    ).execute({
      walletId,
      playerId,
      providerId,
      externalTransactionId: winExternalId,
      idempotencyKey: randomUUID(),
      payloadHash: 'b'.repeat(64),
      roundId: 'round-001',
      gameId: 'game-001',
      amount: '30.00',
      currency: 'BRL',
    });

    expect(win.status).toBe('PROCESSED');

    const refundInput = makeRefundInput(
      walletId,
      playerId,
      providerId,
      winExternalId,
    );

    await expect(
      new ProcessRefundUseCase(orm.em.fork()).execute(refundInput),
    ).rejects.toThrow('INVALID_REFUND_REFERENCE');

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('130.00');
    expect(wallet?.version).toBe(3);
  });
  
  test('dois REFUNDs simultâneos não devem estornar a mesma BET duas vezes', async () => {
    const { walletId, playerId } = await prepareWallet();

    const providerId = `provider-${randomUUID()}`;
    const betExternalId = `bet-${randomUUID()}`;

    const bet = await new ProcessBetUseCase(
      orm.em.fork(),
    ).execute(
      makeBetInput(
        walletId,
        playerId,
        providerId,
        betExternalId,
      ),
    );

    expect(bet.status).toBe('PROCESSED');
    expect(bet.balance).toBe('70.00');

    // Dois estornos distintos para a mesma BET.
    const firstInput = makeRefundInput(
      walletId,
      playerId,
      providerId,
      betExternalId,
    );

    const secondInput = makeRefundInput(
      walletId,
      playerId,
      providerId,
      betExternalId,
    );

    const results = await Promise.allSettled([
      new ProcessRefundUseCase(orm.em.fork()).execute(firstInput),
      new ProcessRefundUseCase(orm.em.fork()).execute(secondInput),
    ]);

    const successful = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<ProcessRefundUseCase['execute']>>
      > => result.status === 'fulfilled',
    );

    const failed = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected',
    );

    // Exatamente um REFUND deve ser processado.
    expect(successful).toHaveLength(1);
    expect(successful[0]?.value.status).toBe('PROCESSED');

    // O outro deve ser impedido.
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(Error);
    expect(failed[0]?.reason.message).toBe(
      'REFUND_ALREADY_EXISTS',
    );

    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    // Saldo inicial 100 - BET 30 + REFUND 30.
    expect(wallet?.balance.toJSON().amount).toBe('100.00');

    // A carteira foi alterada apenas pela BET e por um REFUND.
    expect(wallet?.version).toBe(4);

    const ledger =
      await new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      ).findByTransactionId(
        successful[0]!.value.transactionId,
      );

    expect(ledger?.direction).toBe('CREDIT');
    expect(ledger?.money.toJSON().amount).toBe('30.00');

    // A solicitação que falhou não pode deixar
    // uma transação adicional persistida.
    const failedInput =
      results[0]?.status === 'rejected'
        ? firstInput
        : secondInput;

    const failedTransaction =
      await new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      ).findByProviderAndExternalId(
        providerId,
        failedInput.externalTransactionId,
      );

    expect(failedTransaction).toBeNull();
  });

  test('deve localizar REFUNDs pendentes pela referência da BET', async () => {
    const { walletId, playerId } = await prepareWallet();

    const providerId = `provider-${randomUUID()}`;
    const betExternalId = `bet-pendente-${randomUUID()}`;

    const refunds = new ProcessRefundUseCase(orm.em.fork());

    // O provedor envia dois REFUNDs antes da BET original.
    const firstRefund = await refunds.execute(
      makeRefundInput(
        walletId,
        playerId,
        providerId,
        betExternalId,
      ),
    );

    const secondRefund = await refunds.execute(
      makeRefundInput(
        walletId,
        playerId,
        providerId,
        betExternalId,
      ),
    );

    expect(firstRefund.status).toBe('PENDING_REFERENCE');
    expect(secondRefund.status).toBe('PENDING_REFERENCE');

    // Consultamos as transações pendentes diretamente
    // no repositório PostgreSQL.
    const repository = new MikroOrmWagerTransactionRepository(
      orm.em.fork(),
    );

    const pendingRefunds =
      await repository.findPendingRefundsByReference(
        providerId,
        betExternalId,
      );

    expect(pendingRefunds).toHaveLength(2);

    const pendingIds = pendingRefunds.map(
      (transaction) => transaction.id,
    );

    expect(pendingIds).toContain(firstRefund.transactionId);
    expect(pendingIds).toContain(secondRefund.transactionId);

    for (const transaction of pendingRefunds) {
      expect(transaction.kind).toBe('REFUND');
      expect(transaction.status).toBe('PENDING_REFERENCE');
      expect(transaction.referenceExternalTransactionId).toBe(
        betExternalId,
      );
      expect(transaction.referenceTransactionId).toBeUndefined();
    }

    // Nenhum dos REFUNDs pendentes pode movimentar o saldo.
    const wallet = await new MikroOrmWalletRepository(
      orm.em.fork(),
    ).findById(walletId);

    expect(wallet?.balance.toJSON().amount).toBe('100.00');
    expect(wallet?.version).toBe(2);

    // Nenhum lançamento financeiro deve existir.
    const ledgerRepository = new MikroOrmWalletLedgerRepository(
      orm.em.fork(),
    );

    const firstLedger = await ledgerRepository.findByTransactionId(
      firstRefund.transactionId,
    );

    const secondLedger = await ledgerRepository.findByTransactionId(
      secondRefund.transactionId,
    );

    expect(firstLedger).toBeNull();
    expect(secondLedger).toBeNull();
  });

});