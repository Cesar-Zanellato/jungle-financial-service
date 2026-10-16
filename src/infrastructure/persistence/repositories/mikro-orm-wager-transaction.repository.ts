import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransaction } from '../../../domain/entities/wager-transaction.js';
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction.js';
import type { WagerTransactionRepository } from '../../../domain/repositories/wager-transaction.repository.js';
import { Money } from '../../../domain/value-objects/money.js';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity.js';
import { LockMode } from '@mikro-orm/core';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository{ 
  constructor(private readonly em: EntityManager) {}

  async findById(
    id: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionOrmEntity,
      { id },
    );

    return entity ? this.toDomain(entity) : null;
  }
  
  async findByIdForUpdate(
    id: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionOrmEntity,
      { id },
      {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      },
    );

    return entity ? this.toDomain(entity) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionOrmEntity,
      {
        providerId,
        externalTransactionId,
      },
    );

    return entity ? this.toDomain(entity) : null;
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionOrmEntity,
      {
        providerId,
        idempotencyKey,
      },
    );

    return entity ? this.toDomain(entity) : null;
  }

  async findActiveReversal(
      referenceTransactionId: string,
      kind: 'REFUND' | 'ROLLBACK',
    ): Promise<WagerTransaction | null> {
      const entity = await this.em.findOne(
        WagerTransactionOrmEntity,
        {
          referenceTransactionId,
          kind,
          status: {
            $in: [
              'PENDING',
              'PENDING_REFERENCE',
              'PROCESSED',
            ],
          },
        },
      );

      return entity ? this.toDomain(entity) : null;
  }

  async findPendingRefundsByReference(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const entities = await this.em.find(
      WagerTransactionOrmEntity,
      {
        providerId,
        referenceExternalTransactionId,
        kind: 'REFUND',
        status: 'PENDING_REFERENCE',
      },
      {
        orderBy: {
          createdAt: 'ASC',
          id: 'ASC',
        },
      },
    );

    return entities.map((entity) => this.toDomain(entity));
  }

  async findPendingRollbacksByReference(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const entities = await this.em.find(
      WagerTransactionOrmEntity,
      {
        providerId,
        referenceExternalTransactionId,
        kind: 'ROLLBACK',
        status: 'PENDING_REFERENCE',
      },
      {
        orderBy: {
          createdAt: 'ASC',
          id: 'ASC',
        },
      },
    );

    return entities.map((entity) => this.toDomain(entity));
  }
  
  async findResolvablePendingReferences(
    limit = 50,
    providerId?: string,
  ): Promise<
    Array<{
      providerId: string;
      referenceExternalTransactionId: string;
    }>
  > {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('INVALID_RECOVERY_BATCH_SIZE');
    }

    const providerFilter = providerId
      ? 'AND p.provider_id = ?'
      : '';

    const parameters: Array<string | number> = [];

    if (providerId) {
      parameters.push(providerId);
    }

    parameters.push(limit);

    const rows = await this.em.getConnection().execute<
      Array<{
        provider_id: string;
        reference_external_transaction_id: string;
      }>
    >(
      `
      SELECT DISTINCT
        p.provider_id,
        p.reference_external_transaction_id
      FROM wager_transactions p
      INNER JOIN wager_transactions original
        ON original.provider_id = p.provider_id
      AND original.external_transaction_id =
          p.reference_external_transaction_id
      WHERE p.status = 'PENDING_REFERENCE'
        AND p.kind IN ('REFUND', 'ROLLBACK')
        AND original.status IN ('PROCESSED', 'REJECTED')
        ${providerFilter}
      ORDER BY
        p.provider_id,
        p.reference_external_transaction_id
      LIMIT ?
      `,
      parameters,
    );

    return rows.map((row) => ({
      providerId: row.provider_id,
      referenceExternalTransactionId:
        row.reference_external_transaction_id,
    }));
  }

  async save(
    transaction: WagerTransaction,
  ): Promise<void> {
    let entity = await this.em.findOne(
      WagerTransactionOrmEntity,
      { id: transaction.id },
    );

    if (!entity) {
      entity = this.em.create(
        WagerTransactionOrmEntity,
        {
          id: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId:
            transaction.externalTransactionId,
          idempotencyKey: transaction.idempotencyKey,
          payloadHash: transaction.payloadHash,
          walletId: transaction.walletId,
          playerId: transaction.playerId,
          roundId: transaction.roundId,
          gameId: transaction.gameId,
          kind: transaction.kind,
          amount: transaction.money.toJSON().amount,
          currency: transaction.money.currency,
          referenceExternalTransactionId:
            transaction.referenceExternalTransactionId,
          referenceTransactionId:
            transaction.referenceTransactionId,
          status: transaction.status,
          failureCode: transaction.failureCode,
          createdAt: transaction.createdAt,
          processedAt: transaction.processedAt,
        },
      );

      this.em.persist(entity);
    } else {
      // Somente os campos de estado podem mudar.
      entity.status = transaction.status;
      entity.failureCode = transaction.failureCode;
      entity.referenceTransactionId =
        transaction.referenceTransactionId;
      entity.processedAt = transaction.processedAt;
    }

    await this.em.flush();
  }

  withEntityManager(
    em: EntityManager,
  ): MikroOrmWagerTransactionRepository {
    return new MikroOrmWagerTransactionRepository(em);
  }

  private toDomain(
    entity: WagerTransactionOrmEntity,
  ): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,

      kind: entity.kind as WagerTransactionKind,

      money: Money.from({
        amount: entity.amount,
        currency: entity.currency,
      }),

      referenceExternalTransactionId:
        entity.referenceExternalTransactionId ?? undefined,

      referenceTransactionId:
        entity.referenceTransactionId ?? undefined,

      status: entity.status as WagerTransactionStatus,

      failureCode: entity.failureCode ?? undefined,
      createdAt: entity.createdAt,
      processedAt: entity.processedAt ?? undefined,
    });
  }
}