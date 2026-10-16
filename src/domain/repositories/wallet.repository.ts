import { Wallet } from '../entities/wallet';

export interface WalletRepository {

  findById(id: string): Promise<Wallet | null>;

  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null>;

  findByIdForUpdate(id: string): Promise<Wallet | null>;
  
  save(wallet: Wallet): Promise<void>;
}
