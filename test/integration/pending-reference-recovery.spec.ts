
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { MikroOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet-ledger.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case.js';
import { PendingReferenceRecoveryService } from '../../src/application/services/pending-reference-recovery.service.js';

describe('Pending reference recovery - PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('recupera REFUND pendente sem duplicar saldo', async () => {
    const walletId = randomUUID();
    const playerId = `player-${randomUUID()}`;
    const providerId = `provider-${randomUUID()}`;
    const betExternalId = `bet-${randomUUID()}`;
    const refundExternalId = `refund-${randomUUID()}`;

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

    // Primeiro, processamos uma BET normalmente.
    const bet = await new ProcessBetUseCase(
      orm.em.fork(),
    ).execute({
      walletId,
      playerId,
      providerId,
      externalTransactionId: betExternalId,
      idempotencyKey: randomUUID(),
      payloadHash: 'a'.repeat(64),
      roundId: 'round-recovery',
      gameId: 'game-recovery',
      amount: '30.00',
      currency: 'BRL',
    });

    expect(bet.status).toBe('PROCESSED');

    // Cria o REFUND com referência ainda não resolvida
    // diretamente como estado persistido de recuperação.
    
    // Simula um REFUND que foi recebido antes da BET,
    // mas permaneceu pendente após uma interrupção.
    //
    // A BET já existe. Criamos apenas o registro
    // PENDING_REFERENCE, sem movimentar a carteira
    // e sem criar lançamento no ledger.

    const refundTransactionId = randomUUID();

    await orm.em.getConnection().execute(
      `
      INSERT INTO wager_transactions (
        id,
        provider_id,
        external_transaction_id,
        idempotency_key,
        payload_hash,
        wallet_id,
        player_id,
        round_id,
        game_id,
        kind,
        amount,
        currency,
        reference_external_transaction_id,
        status,
        created_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'REFUND', ?, ?, ?, 'PENDING_REFERENCE', NOW()
      )
      `,
      [
        refundTransactionId,
        providerId,
        refundExternalId,
        randomUUID(),
        'b'.repeat(64),
        walletId,
        playerId,
        'round-recovery',
        'game-recovery',
        '30.00',
        'BRL',
        betExternalId,
      ],
    );

    // Simula a existência de uma pendência após interrupção.
    // Este UPDATE é restrito ao banco de testes.
    await orm.em.getConnection().execute(
      `
      UPDATE wager_transactions
      SET status = 'PENDING_REFERENCE',
          reference_transaction_id = NULL,
          processed_at = NULL
      WHERE id = ?
      `,
      [refundTransactionId],
    );

    const recovery = new PendingReferenceRecoveryService(
      orm.em.fork(),
    );

    const firstRun = await recovery.runOnce(50, providerId);

    expect(firstRun.referencesFound).toBe(1);
    expect(firstRun.processed).toBe(1);
    expect(firstRun.failed).toBe(0);

    const secondRun = await recovery.runOnce(50, providerId);

    expect(secondRun.referencesFound).toBe(0);
    expect(secondRun.processed).toBe(0);
    expect(secondRun.failed).toBe(0);

    const repository =
      new MikroOrmWagerTransactionRepository(
        orm.em.fork(),
      );

    const recoveredRefund = await repository.findById(
      refundTransactionId,
    );

    expect(recoveredRefund?.status).toBe('PROCESSED');

    const updatedWallet =
      await new MikroOrmWalletRepository(
        orm.em.fork(),
      ).findById(walletId);

    expect(
      updatedWallet?.balance.toJSON().amount,
    ).toBe('100.00');

    const ledgerRepository =
      new MikroOrmWalletLedgerRepository(
        orm.em.fork(),
      );

    const refundLedger =
      await ledgerRepository.findByTransactionId(
        refundTransactionId,
      );

    expect(refundLedger).not.toBeNull();
    expect(refundLedger?.direction).toBe('CREDIT');
  });
});