import{ Money } from '../value-objects/money';

export interface WalletProps{
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet{
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ){}

  public static open(
    id: string,
    playerId: string,
    currency: string,
  ): Wallet{
    if (!id || !playerId){
      throw new Error('INVALID_WALLET_DATA');
    }

    const now = new Date();

    return new Wallet(
      id,
      playerId,
      currency,
      Money.zero(currency),
      1,
      now,
      now,
    );
  }

  public static rehydrate(props: WalletProps): Wallet{
    if (props.balance.currency !== props.currency){
      throw new Error('CURRENCY_MISMATCH');
    }

    return new Wallet(
      props.id,
      props.playerId,
      props.currency,
      props.balance,
      props.version,
      props.createdAt,
      props.updatedAt,
    );
  }

  public get balance(): Money{
    return this._balance;
  }

  public get version(): number{
    return this._version;
  }

  public get updatedAt(): Date{
    return new Date(this._updatedAt);
  }

  public credit(amount: Money): void{
    this.assertCurrency(amount);

    if (!amount.isPositive()){
      throw new Error('INVALID_CREDIT_AMOUNT');
    }

    this._balance = this._balance.add(amount);
    this.registerBalanceChange();
  }

  public debit(amount: Money): void{
    this.assertCurrency(amount);

    if (!amount.isPositive()){
      throw new Error('INVALID_DEBIT_AMOUNT');
    }

    if (this._balance.isLessThan(amount)){
      throw new Error('INSUFFICIENT_FUNDS');
    }

    this._balance = this._balance.subtract(amount);
    this.registerBalanceChange();
  }

  private assertCurrency(amount: Money): void{
    if (amount.currency !== this.currency){
      throw new Error('CURRENCY_MISMATCH');
    }
  }

  private registerBalanceChange(): void{
    this._version += 1;
    this._updatedAt = new Date();
  }
}
