import { describe, expect, test } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind,
} from './wager-transaction';
import { Money } from '../value-objects/money';

function createTransaction(
  kind: WagerTransactionKind = 'BET',
  referenceExternalTransactionId?: string,
): WagerTransaction {
  return WagerTransaction.create({
    id: 'transaction-1',
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-1:external-1',
    payloadHash: 'hash-123',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: Money.from({
      amount: '30.00',
      currency: 'BRL',
    }),
    referenceExternalTransactionId,
  });
}

describe('WagerTransaction', () => {
  test('deve criar uma transação pendente', () => {
    const transaction = createTransaction();

    expect(transaction.status).toBe('PENDING');
    expect(transaction.isTerminal()).toBe(false);
  });

  test('deve marcar uma transação como processada', () => {
    const transaction = createTransaction();

    transaction.markProcessed();

    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.processedAt).toBeDefined();
  });

  test('deve impedir processamento duplicado', () => {
    const transaction = createTransaction();

    transaction.markProcessed();

    expect(() => transaction.markProcessed()).toThrow(
      'TRANSACTION_ALREADY_TERMINAL',
    );
  });

  test('deve rejeitar uma transação com código de falha', () => {
    const transaction = createTransaction();

    transaction.reject('INSUFFICIENT_FUNDS');

    expect(transaction.status).toBe('REJECTED');
    expect(transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('deve impedir reversão sem referência', () => {
    expect(() => createTransaction('REFUND')).toThrow(
      'REFERENCE_REQUIRED',
    );

    expect(() => createTransaction('ROLLBACK')).toThrow(
      'REFERENCE_REQUIRED',
    );
  });

  test('deve marcar referência pendente', () => {
    const transaction = createTransaction(
      'REFUND',
      'original-bet',
    );

    transaction.markPendingReference();

    expect(transaction.status).toBe('PENDING_REFERENCE');
    expect(transaction.isTerminal()).toBe(false);
  });

  test('deve reconhecer transações sem efeito financeiro', () => {
    const transaction = createTransaction('LOSS');

    expect(transaction.affectsBalance()).toBe(false);
    expect(transaction.ledgerDirectionFor()).toBeNull();
  });

  test('deve identificar a direção de BET e WIN', () => {
    expect(
      createTransaction('BET').ledgerDirectionFor(),
    ).toBe('DEBIT');

    expect(
      createTransaction('WIN').ledgerDirectionFor(),
    ).toBe('CREDIT');
  });

  test('deve inverter a direção em ROLLBACK', () => {
    const transaction = createTransaction(
      'ROLLBACK',
      'original-transaction',
    );

    expect(transaction.ledgerDirectionFor('DEBIT')).toBe(
      'CREDIT',
    );

    expect(transaction.ledgerDirectionFor('CREDIT')).toBe(
      'DEBIT',
    );
  });

  test('deve comparar o hash do payload', () => {
    const transaction = createTransaction();

    expect(transaction.matchesPayload('hash-123')).toBe(true);
    expect(transaction.matchesPayload('outro-hash')).toBe(false);
  });

  test('deve impedir alteração de estado terminal', () => {
    const transaction = createTransaction();

    transaction.reject('INSUFFICIENT_FUNDS');

    expect(() => transaction.markProcessed()).toThrow(
      'TRANSACTION_ALREADY_TERMINAL',
    );
  });

  test('deve permitir associar a transação referenciada', () => {
    const transaction = createTransaction(
      'REFUND',
      'original-bet',
    );

    transaction.setReferenceTransactionId('internal-bet-id');

    expect(transaction.referenceTransactionId).toBe(
      'internal-bet-id',
    );
  });
});
