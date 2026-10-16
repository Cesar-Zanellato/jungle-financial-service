import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { walletSchema } from './infrastructure/persistence/entities/wallet.orm-entity.js';
import 'dotenv/config';
import { LedgerEntrySchema } from './infrastructure/persistence/entities/ledger-entry.orm-entity.js';
import { wagerTransactionSchema } from './infrastructure/persistence/entities/wager-transaction.orm-entity.js';

export default defineConfig({
  host: process.env.DATABASE_HOST ?? '127.0.0.1',
  port: Number(process.env.DATABASE_PORT ?? '5432'),
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  dbName: process.env.DATABASE_NAME,

  entities: [
    walletSchema, 
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

  debug: process.env.NODE_ENV === 'development',
});