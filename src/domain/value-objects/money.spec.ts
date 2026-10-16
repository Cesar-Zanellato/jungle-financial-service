import { describe, expect, test } from 'bun:test';
import { Money } from './money';

describe('Money', () => {
  test('deve criar um valor monetário válido', () => {
    const money = Money.from({
      amount: '25.00',
      currency: 'BRL',
    });

    expect(money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  test('deve somar dois valores', () => {
    const a = Money.from({ amount: '10.50', currency: 'BRL' });
    const b = Money.from({ amount: '2.25', currency: 'BRL' });

    expect(a.add(b).toJSON().amount).toBe('12.75');
  });

  test('deve subtrair dois valores', () => {
    const a = Money.from({ amount: '10.50', currency: 'BRL' });
    const b = Money.from({ amount: '2.25', currency: 'BRL' });

    expect(a.subtract(b).toJSON().amount).toBe('8.25');
  });

  test('deve impedir operações entre moedas diferentes', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '5.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow('CURRENCY_MISMATCH');
    expect(() => brl.subtract(usd)).toThrow('CURRENCY_MISMATCH');
  });

  test('deve rejeitar valores inválidos', () => {
    const invalidAmounts = [
      '-10.00',
      '10.123',
      '1e3',
      'NaN',
      'Infinity',
      '',
      '10',
    ];

    for (const amount of invalidAmounts) {
      expect(() =>
        Money.from({ amount, currency: 'BRL' }),
      ).toThrow('INVALID_MONEY_AMOUNT');
    }
  });

  test('deve identificar valores negativos e zero', () => {
    const zero = Money.zero('BRL');
    const positive = Money.from({
      amount: '5.00',
      currency: 'BRL',
    });

    expect(zero.isZero()).toBe(true);
    expect(positive.isPositive()).toBe(true);
    expect(positive.negate().isNegative()).toBe(true);
  });

  test('deve preservar a precisão decimal', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });

    expect(a.add(b).toJSON().amount).toBe('0.30');
  });

  test('deve manter o objeto original imutável', () => {
    const original = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const result = original.add(
      Money.from({ amount: '5.00', currency: 'BRL' }),
    );

    expect(original.toJSON().amount).toBe('10.00');
    expect(result.toJSON().amount).toBe('15.00');
  });
});
