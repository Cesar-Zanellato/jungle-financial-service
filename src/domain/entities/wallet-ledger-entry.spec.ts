import { describe, expect, test } from 'bun:test';
import {
  WalletLedgerEntry,
  WalletLedgerEntryProps,
} from './wallet-ledger-entry';
import { Money } from '../value-objects/money';

function money(amount: string, currency = 'BRL'): Money {
  return Money.from({ amount, currency });
}

function validEntry(
  overrides: Partial<WalletLedgerEntryProps> = {},
): WalletLedgerEntryProps {
  return {
    id: 'ledger-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction: 'DEBIT',
    money: money('30.00'),
    balanceBefore: money('100.00'),
    balanceAfter: money('70.00'),
    createdAt: new Date('2026-01-01T10:00:00Z'),
    ...overrides,
  };
}

describe('WalletLedgerEntry', () => {
  test('deve criar um débito válido', () => {
    const entry = WalletLedgerEntry.create(validEntry());

    expect(entry.direction).toBe('DEBIT');
    expect(entry.money.toJSON().amount).toBe('30.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('70.00');
  });

  test('deve criar um crédito válido', () => {
    const entry = WalletLedgerEntry.create(
      validEntry({
        direction: 'CREDIT',
        money: money('50.00'),
        balanceBefore: money('70.00'),
        balanceAfter: money('120.00'),
      }),
    );

    expect(entry.direction).toBe('CREDIT');
    expect(entry.balanceAfter.toJSON().amount).toBe('120.00');
  });

  test('deve rejeitar saldo posterior incorreto', () => {
    expect(() =>
      WalletLedgerEntry.create(
        validEntry({
          balanceAfter: money('80.00'),
        }),
      ),
    ).toThrow('LEDGER_BALANCE_MISMATCH');
  });

  /*test('deve rejeitar saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create(
        validEntry({
          money: money('150.00'),
          balanceAfter: money('0.00'),
        }),
      ),
    ).toThrow('LEDGER_BALANCE_MISMATCH');
  });*/

  test('deve rejeitar saldo negativo', () => {
  const negativeBalance = Money.zero('BRL').subtract(
    money('50.00'),
  );

  expect(() =>
    WalletLedgerEntry.create(
        validEntry({
            money: money('150.00'),
            balanceAfter: negativeBalance,
        }),
      ),
    ).toThrow('NEGATIVE_LEDGER_BALANCE');
  });

  test('deve rejeitar valores monetários de moedas diferentes', () => {
    expect(() =>
      WalletLedgerEntry.create(
        validEntry({
          money: money('30.00', 'USD'),
        }),
      ),
    ).toThrow('CURRENCY_MISMATCH');
  });

  test('deve rejeitar valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create(
        validEntry({
          money: Money.zero('BRL'),
        }),
      ),
    ).toThrow('INVALID_LEDGER_AMOUNT');
  });

  test('deve impedir alteração externa da data', () => {
    const originalDate = new Date('2026-01-01T10:00:00Z');

    const entry = WalletLedgerEntry.create(
      validEntry({ createdAt: originalDate }),
    );

    originalDate.setFullYear(2030);

    const returnedDate = entry.createdAt;
    returnedDate.setFullYear(2040);

    expect(entry.createdAt.getUTCFullYear()).toBe(2026);
  });

  test('deve reconstruir uma entrada persistida', () => {
    const entry = WalletLedgerEntry.rehydrate(validEntry());

    expect(entry.transactionId).toBe('transaction-1');
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('70.00');
  });
});
