import { EntitySchema } from '@mikro-orm/core';

export class WagerTransactionOrmEntity {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status!: string;
  failureCode?: string;
  createdAt!: Date;
  processedAt?: Date;
}

export const wagerTransactionSchema = new EntitySchema({
  class: WagerTransactionOrmEntity,
  tableName: 'wager_transactions',

  properties: {
    id: {
      type: 'uuid',
      primary: true,
    },
    providerId: {
      type: 'string',
      fieldName: 'provider_id',
      length: 255,
    },
    externalTransactionId: {
      type: 'string',
      fieldName: 'external_transaction_id',
      length: 255,
    },
    idempotencyKey: {
      type: 'string',
      fieldName: 'idempotency_key',
      length: 255,
    },
    payloadHash: {
      type: 'string',
      fieldName: 'payload_hash',
      length: 64,
    },
    walletId: {
      type: 'uuid',
      fieldName: 'wallet_id',
    },
    playerId: {
      type: 'string',
      fieldName: 'player_id',
      length: 255,
    },
    roundId: {
      type: 'string',
      fieldName: 'round_id',
      length: 255,
    },
    gameId: {
      type: 'string',
      fieldName: 'game_id',
      length: 255,
    },
    kind: {
      type: 'string',
      length: 20,
    },
    amount: {
      type: 'decimal',
      precision: 20,
      scale: 2,
    },
    currency: {
      type: 'string',
      length: 3,
    },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      length: 255,
      nullable: true,
    },
    referenceTransactionId: {
      type: 'uuid',
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    status: {
      type: 'string',
      length: 30,
    },
    failureCode: {
      type: 'string',
      fieldName: 'failure_code',
      length: 100,
      nullable: true,
    },
    createdAt: {
      type: 'datetime',
      fieldName: 'created_at',
    },
    processedAt: {
      type: 'datetime',
      fieldName: 'processed_at',
      nullable: true,
    },
  },
});