
import {
  IsString,
  IsNotEmpty,
  IsUUID,
  Matches,
} from 'class-validator';

export class FinancialTransactionDto {
  @IsUUID()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  externalTransactionId!: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;

  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @IsString()
  @IsNotEmpty()
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  gameId!: string;

  // Valores monetários são sempre strings.
  // Exemplos válidos: "0.01", "30.00", "120.50".
  @IsString()
  @Matches(/^(0|[1-9]\d*)\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class FinancialReversalDto extends FinancialTransactionDto {
  @IsString()
  @IsNotEmpty()
  referenceExternalTransactionId!: string;
}
