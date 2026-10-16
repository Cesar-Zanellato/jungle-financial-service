import { EntitySchema } from '@mikro-orm/core';

export class WalletOrmEntity {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const walletSchema = new EntitySchema({
  class: WalletOrmEntity,

  tableName: 'wallets',

  properties: {
    id:{
      type: 'uuid',
      primary: true,
    },
    playerId:{
      type: 'string',
      fieldName: 'player_id',
      length: 255,
    },
    currency:{
      type: 'string',
      length: 3,
    },
    balance:{
      type: 'decimal',
      precision: 20,
      scale: 2,
    },
    version:{
      type: 'integer',
    },
    createdAt:{
      type: 'datetime',
      fieldName: 'created_at',
    },
    updatedAt:{
      type: 'datetime',
      fieldName: 'updated_at',
    },
  },
});
