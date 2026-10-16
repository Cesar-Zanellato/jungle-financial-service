import { EntitySchema } from '@mikro-orm/core';

export class LedgerEntryOrmEntity {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: 'DEBIT' | 'CREDIT';
  currency!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema =
  new EntitySchema<LedgerEntryOrmEntity>({
    class: LedgerEntryOrmEntity,
    tableName: 'ledger_entries',

    properties: {
      id: {
        type: 'uuid',
        primary: true,
      },

      walletId: {
        type: 'uuid',
        fieldName: 'wallet_id',
      },

      transactionId: {
        type: 'uuid',
        fieldName: 'transaction_id',
      },

      direction: {
        type: 'string',
        length: 6,
      },

      currency: {
        type: 'string',
        length: 3,
      },

      amount: {
        type: 'decimal',
        precision: 20,
        scale: 2,
      },

      balanceBefore: {
        type: 'decimal',
        fieldName: 'balance_before',
        precision: 20,
        scale: 2,
      },

      balanceAfter: {
        type: 'decimal',
        fieldName: 'balance_after',
        precision: 20,
        scale: 2,
      },

      createdAt: {
        type: 'datetime',
        fieldName: 'created_at',
      },
    },
  });