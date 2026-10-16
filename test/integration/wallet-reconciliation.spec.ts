
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.test.config.js';
import { WalletReconciliationService } from '../../src/application/services/wallet-reconciliation.service.js';

describe('Wallet reconciliation', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('detecta divergência sem alterar saldo ou ledger', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();

    const em = orm.em.fork();

    // Carteira inicialmente consistente: saldo zero.
    await em.getConnection().execute(
      `
      INSERT INTO wallets (
        id,
        player_id,
        currency,
        balance,
        version,
        created_at,
        updated_at
      )
      VALUES (?, ?, 'BRL', 0, 1, NOW(), NOW())
      `,
      [walletId, playerId],
    );

    const reconciliation = new WalletReconciliationService(
      orm.em,
    );

    const initial = await reconciliation.reconcile(walletId);

    expect(initial.consistent).toBe(true);
    expect(Number(initial.materializedBalance)).toBe(0);
    expect(Number(initial.ledgerBalance)).toBe(0);

    // Simula uma divergência no saldo materializado.
    // Não cria lançamentos financeiros.
    await em.getConnection().execute(
      `
      UPDATE wallets
      SET balance = 50.00,
          version = version + 1,
          updated_at = NOW()
      WHERE id = ?
      `,
      [walletId],
    );

    const divergent = await reconciliation.reconcile(walletId);

    expect(divergent.consistent).toBe(false);
    expect(Number(divergent.materializedBalance)).toBe(50);
    expect(Number(divergent.ledgerBalance)).toBe(0);

    // A reconciliação não deve corrigir o saldo.
    const rows = await em.getConnection().execute<
      Array<{ balance: string; ledger_count: string }>
    >(
      `
      SELECT
        w.balance::text AS balance,
        (
          SELECT COUNT(*)::text
          FROM ledger_entries l
          WHERE l.wallet_id = w.id
        ) AS ledger_count
      FROM wallets w
      WHERE w.id = ?
      `,
      [walletId],
    );

    expect(Number(rows[0]?.balance)).toBe(50);
    expect(rows[0]?.ledger_count).toBe('0');

    // Limpeza da carteira criada exclusivamente para o teste.
    await em.getConnection().execute(
      'DELETE FROM wallets WHERE id = ?',
      [walletId],
    );
  });
});