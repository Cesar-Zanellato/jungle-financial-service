import { createHash } from 'node:crypto';
import {
  FinancialTransactionDto,
  FinancialReversalDto,
} from './financial-transaction.dto.js';

type FinancialOperation =
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

export function calculateFinancialPayloadHash(
  operation: FinancialOperation,
  input: FinancialTransactionDto | FinancialReversalDto,
): string {
  const reversalInput = input as FinancialReversalDto;

  const payload = {
    operation,
    walletId: input.walletId,
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    roundId: input.roundId,
    gameId: input.gameId,
    amount: input.amount,
    currency: input.currency,
    referenceExternalTransactionId:
      operation === 'REFUND' || operation === 'ROLLBACK'
        ? reversalInput.referenceExternalTransactionId
        : null,
  };

  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}