import { Money } from '../value-objects/money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface WalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {
    Object.freeze(this);
  }

  public static create(
    props: WalletLedgerEntryProps,
  ): WalletLedgerEntry {
    this.validate(props);

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt.getTime()),
    );
  }

  public static rehydrate(
    props: WalletLedgerEntryProps,
  ): WalletLedgerEntry {
    // Reconstrói um registro persistido.
    // Não executa novamente as regras de transição.
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt.getTime()),
    );
  }

  public get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  private static validate(
    props: WalletLedgerEntryProps,
  ): void {
    if (
      !props.id?.trim() ||
      !props.walletId?.trim() ||
      !props.transactionId?.trim()
    ) {
      throw new Error('INVALID_LEDGER_DATA');
    }

    if (
      props.direction !== 'DEBIT' &&
      props.direction !== 'CREDIT'
    ) {
      throw new Error('INVALID_LEDGER_DIRECTION');
    }

    if (
      !(props.createdAt instanceof Date) ||
      Number.isNaN(props.createdAt.getTime())
    ) {
      throw new Error('INVALID_LEDGER_DATE');
    }

    const currency = props.money.currency;

    if (
      props.balanceBefore.currency !== currency ||
      props.balanceAfter.currency !== currency
    ) {
      throw new Error('CURRENCY_MISMATCH');
    }

    if (!props.money.isPositive()) {
      throw new Error('INVALID_LEDGER_AMOUNT');
    }

    if (
      props.balanceBefore.isNegative() ||
      props.balanceAfter.isNegative()
    ) {
      throw new Error('NEGATIVE_LEDGER_BALANCE');
    }

    const expectedBalance =
      props.direction === 'CREDIT'
        ? props.balanceBefore.add(props.money)
        : props.balanceBefore.subtract(props.money);

    if (!expectedBalance.equals(props.balanceAfter)) {
      throw new Error('LEDGER_BALANCE_MISMATCH');
    }
  }
}
