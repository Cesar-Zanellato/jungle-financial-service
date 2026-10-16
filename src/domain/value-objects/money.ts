import {Decimal} from 'decimal.js';

export interface MoneyProps{
  amount: string;
  currency: string;
}

export class Money{
  private static readonly AMOUNT_PATTERN = /^\d+\.\d{2}$/;
  private static readonly CURRENCY_PATTERN = /^[A-Z]{3}$/;

  private readonly value: Decimal;
  public readonly currency: string;

  private constructor(value: Decimal, currency: string){
    this.value = value;
    this.currency = currency;
    Object.freeze(this);
  }

  public static from(props:MoneyProps):Money{
    if(
      typeof props.amount !== 'string' ||
      !Money.AMOUNT_PATTERN.test(props.amount)
    ) {
      throw new Error('INVALID_MONEY_AMOUNT');
    }

    if(
      typeof props.currency !== 'string' ||
      !Money.CURRENCY_PATTERN.test(props.currency)
    ){
      throw new Error('INVALID_CURRENCY');
    }

    return new Money(new Decimal(props.amount), props.currency);
  }

  public static zero(currency: string): Money{
    return Money.from({ amount: '0.00', currency });
  }

  private static fromCalculation(
    value: Decimal,
    currency: string,
  ):Money{
    if(!value.isFinite() || value.decimalPlaces() > 2){
      throw new Error('INVALID_MONEY_CALCULATION');
    }

    return new Money(value, currency);
  }

  private assertSameCurrency(other: Money):void{
    if(this.currency !== other.currency){
      throw new Error('CURRENCY_MISMATCH');
    }
  }

  public add(other: Money):Money{
    this.assertSameCurrency(other);

    return Money.fromCalculation(
      this.value.plus(other.value),
      this.currency,
    );
  }

  public subtract(other: Money):Money{
    this.assertSameCurrency(other);

    return Money.fromCalculation(
      this.value.minus(other.value),
      this.currency,
    );
  }

  public negate():Money{
    return Money.fromCalculation(this.value.negated(), this.currency);
  }

  public isZero():boolean{
    return this.value.isZero();
  }

  public isPositive():boolean{
    return this.value.greaterThan(0);
  }

  public isNegative():boolean{
    return this.value.lessThan(0);
  }

  public isLessThan(other:Money):boolean{
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  public equals(other:Money):boolean{
    return (
      this.currency === other.currency &&
      this.value.equals(other.value)
    );
  }

  public toJSON():MoneyProps{
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  public toString():string{
    return `${this.currency} ${this.value.toFixed(2)}`;
  }
}
