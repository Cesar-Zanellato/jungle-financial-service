import { EntityManager } from '@mikro-orm/postgresql';
import { Wallet } from '../../../domain/entities/wallet.js';
import { Money } from '../../../domain/value-objects/money.js';
import type { WalletRepository } from '../../../domain/repositories/wallet.repository.js';
import { WalletOrmEntity } from '../entities/wallet.orm-entity.js';
import { LockMode } from '@mikro-orm/core';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}
  
  async findByIdForUpdate(id: string): Promise<Wallet | null> {
  const entity = await this.em.findOne(
    WalletOrmEntity,
    { id },
    {
      lockMode: LockMode.PESSIMISTIC_WRITE,
    },
  );

  return entity ? this.toDomain(entity) : null;
  }


  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletOrmEntity, { id });

    if (!entity) {
      return null;
    }

    return this.toDomain(entity);
  }

  async findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletOrmEntity, {
      playerId,
      currency,
    });

    if (!entity) {
      return null;
    }

    return this.toDomain(entity);
  }

  async save(wallet: Wallet): Promise<void> {
    const existing = await this.em.findOne(WalletOrmEntity, {
      id: wallet.id,
    });

    if (existing) {
      existing.balance = wallet.balance.toJSON().amount;
      existing.version = wallet.version;
      existing.updatedAt = wallet.updatedAt;

      await this.em.flush();
      return;
    }

    const entity = this.em.create(WalletOrmEntity, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });

    this.em.persist(entity);
    await this.em.flush();
  }

  private toDomain(entity: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({
        amount: entity.balance,
        currency: entity.currency,
      }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  withEntityManager(
    em: EntityManager,
  ): MikroOrmWalletRepository {
    return new MikroOrmWalletRepository(em);
  }


}
