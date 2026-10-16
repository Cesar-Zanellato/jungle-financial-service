import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

if (process.env.POSTGRES_DB !== 'jungle_financial_test') {
  throw new Error('INVALID_TEST_DATABASE');
}

import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { LedgerEntrySchema } from './infrastructure/persistence/entities/ledger-entry.orm-entity.js';
import { WalletOrmEntity } from './infrastructure/persistence/entities/wallet.orm-entity.js';
import { wagerTransactionSchema } from './infrastructure/persistence/entities/wager-transaction.orm-entity.js';

export default defineConfig({
  host: '127.0.0.1',
  port: 5432,

  dbName: 'jungle_financial_test',
  user: 'jungle_app',
  password: process.env.POSTGRES_PASSWORD,

  entities: [
    WalletOrmEntity, 
    LedgerEntrySchema,
    wagerTransactionSchema,
  ],

  extensions: [Migrator],

  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    transactional: true,
    allOrNothing: true,
  },
});