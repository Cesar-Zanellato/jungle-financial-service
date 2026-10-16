import { describe, expect, test } from 'bun:test';
import { Wallet } from './wallet';
import { Money } from '../value-objects/money';

describe('Wallet', () => {
  test('deve abrir uma carteira com saldo zero', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');

    expect(wallet.balance.toJSON().amount).toBe('0.00');
    expect(wallet.version).toBe(1);
  });

  test('deve creditar um valor na carteira', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');

    wallet.credit(Money.from({
      amount: '100.00',
      currency: 'BRL',
    }));

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(2);
  });

  test('deve debitar um valor da carteira', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');

    wallet.credit(Money.from({
      amount: '100.00',
      currency: 'BRL',
    }));

    wallet.debit(Money.from({
      amount: '30.00',
      currency: 'BRL',
    }));

    expect(wallet.balance.toJSON().amount).toBe('70.00');
    expect(wallet.version).toBe(3);
  });

  test('deve impedir saldo negativo', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');

    wallet.credit(Money.from({
      amount: '50.00',
      currency: 'BRL',
    }));

    expect(() => {
      wallet.debit(Money.from({
        amount: '80.00',
        currency: 'BRL',
      }));
    }).toThrow('INSUFFICIENT_FUNDS');

    expect(wallet.balance.toJSON().amount).toBe('50.00');
    expect(wallet.version).toBe(2);
  });

  test('deve impedir moedas diferentes', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');

    expect(() => {
      wallet.credit(Money.from({
        amount: '10.00',
        currency: 'USD',
      }));
    }).toThrow('CURRENCY_MISMATCH');
  });

  test('deve impedir crédito com valor zero', () => {
    const wallet = Wallet.open('wallet-1', 'player-1', 'BRL');

    expect(() => {
      wallet.credit(Money.zero('BRL'));
    }).toThrow('INVALID_CREDIT_AMOUNT');
  });

  test('deve reconstruir uma carteira persistida', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: Money.from({
        amount: '75.00',
        currency: 'BRL',
      }),
      version: 4,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    });

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(4);
  });
});
