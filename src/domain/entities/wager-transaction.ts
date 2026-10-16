import { Money } from '../value-objects/money';

export type WagerTransactionKind =
  | 'OPENING'
  | 'BET'
  | 'WIN'
  | 'LOSS'
  | 'REFUND'
  | 'ROLLBACK';

export type WagerTransactionStatus =
  | 'PENDING'
  | 'PENDING_REFERENCE'
  | 'PROCESSED'
  | 'REJECTED'
  | 'FAILED';

export type WagerLedgerDirection = 'DEBIT' | 'CREDIT';

export interface WagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: WagerTransactionStatus;
  failureCode?: string;
  createdAt: Date;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private _referenceTransactionId: string | undefined,
    private _status: WagerTransactionStatus,
    private _failureCode: string | undefined,
    private readonly _createdAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  public static create(
    props: Omit<
      WagerTransactionProps,
      'status' | 'createdAt' | 'processedAt' | 'failureCode'
    >,
  ): WagerTransaction {
    const requiredFields = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];

    if (
      requiredFields.some(
        (value) => !value || !value.trim(),
      )
    ) {
      throw new Error('INVALID_TRANSACTION_DATA');
    }

    if (!props.money.isPositive()) {
      throw new Error('INVALID_TRANSACTION_AMOUNT');
    }

    if (
      (props.kind === 'REFUND' ||
        props.kind === 'ROLLBACK') &&
      !props.referenceExternalTransactionId?.trim()
    ) {
      throw new Error('REFERENCE_REQUIRED');
    }

    const now = new Date();

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.referenceTransactionId,
      'PENDING',
      undefined,
      now,
      undefined,
    );
  }

  public static rehydrate(
    props: WagerTransactionProps,
  ): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.referenceTransactionId,
      props.status,
      props.failureCode,
      new Date(props.createdAt),
      props.processedAt
        ? new Date(props.processedAt)
        : undefined,
    );
  }

  public get status(): WagerTransactionStatus {
    return this._status;
  }

  public get failureCode(): string | undefined {
    return this._failureCode;
  }

  public get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  public get createdAt(): Date {
    return new Date(this._createdAt);
  }

  public get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt)
      : undefined;
  }

  public isTerminal(): boolean {
    return (
      this._status === 'PROCESSED' ||
      this._status === 'REJECTED' ||
      this._status === 'FAILED'
    );
  }

  public affectsBalance(): boolean {
    return this.kind !== 'LOSS';
  }

  public requiresReference(): boolean {
    return (
      this.kind === 'REFUND' ||
      this.kind === 'ROLLBACK'
    );
  }

  public matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  public ledgerDirectionFor(
    referenceDirection?: WagerLedgerDirection,
  ): WagerLedgerDirection | null {
    switch (this.kind) {
      case 'OPENING':
      case 'WIN':
      case 'REFUND':
        return 'CREDIT';

      case 'BET':
        return 'DEBIT';

      case 'LOSS':
        return null;

      case 'ROLLBACK':
        if (!referenceDirection) {
          throw new Error('REFERENCE_DIRECTION_REQUIRED');
        }

        return referenceDirection === 'DEBIT'
          ? 'CREDIT'
          : 'DEBIT';
    }
  }

  public setReferenceTransactionId(
    transactionId: string,
  ): void {
    this.assertNotTerminal();

    if (!this.requiresReference()) {
      throw new Error('REFERENCE_NOT_ALLOWED');
    }

    if (!transactionId.trim()) {
      throw new Error('INVALID_REFERENCE');
    }

    this._referenceTransactionId = transactionId;
  }

  public markPendingReference(): void {
    this.assertNotTerminal();

    if (!this.requiresReference()) {
      throw new Error('REFERENCE_NOT_REQUIRED');
    }

    this._status = 'PENDING_REFERENCE';
  }

  public markProcessed(): void {
    this.assertNotTerminal();

    this._status = 'PROCESSED';
    this._failureCode = undefined;
    this._processedAt = new Date();
  }

  public reject(failureCode: string): void {
    this.assertNotTerminal();
    this.assertFailureCode(failureCode);

    this._status = 'REJECTED';
    this._failureCode = failureCode;
    this._processedAt = new Date();
  }

  public fail(failureCode: string): void {
    this.assertNotTerminal();
    this.assertFailureCode(failureCode);

    this._status = 'FAILED';
    this._failureCode = failureCode;
    this._processedAt = new Date();
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new Error('TRANSACTION_ALREADY_TERMINAL');
    }
  }

  private assertFailureCode(failureCode: string): void {
    if (!failureCode?.trim()) {
      throw new Error('INVALID_FAILURE_CODE');
    }
  }
}
