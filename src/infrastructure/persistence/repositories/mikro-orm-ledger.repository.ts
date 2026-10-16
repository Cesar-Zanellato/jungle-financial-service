import { EntityManager } from '@mikro-orm/postgresql';

import {
  LedgerEntryOrmEntity,
} from '../entities/ledger-entry.orm-entity.js';

export interface NewLedgerEntry {
  id: string;
  walletId: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  currency: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export class MikroOrmLedgerRepository {
  constructor(
    private readonly em: EntityManager,
  ) {}

  async append(entry: NewLedgerEntry): Promise<void> {
    const entity = this.em.create(LedgerEntryOrmEntity, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      currency: entry.currency,
      amount: entry.amount,
      balanceBefore: entry.balanceBefore,
      balanceAfter: entry.balanceAfter,
      createdAt: entry.createdAt,
    });

    this.em.persist(entity);
    await this.em.flush();
  }

  async findById(
    id: string,
  ): Promise<LedgerEntryOrmEntity | null> {
    return this.em.findOne(LedgerEntryOrmEntity, { id });
  }

  async findByWalletId(
    walletId: string,
  ): Promise<LedgerEntryOrmEntity[]> {
    return this.em.find(
      LedgerEntryOrmEntity,
      { walletId },
      {
        orderBy: {
          createdAt: 'ASC',
          id: 'ASC',
        },
      },
    );
  }
}