import { EntityManager } from '@mikro-orm/postgresql';
import { Wallet } from '../../domain/entities/wallet.js';
import { Money } from '../../domain/value-objects/money.js';
import { MikroOrmWalletRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';


export class WalletTransactionService {
  constructor(private readonly em: EntityManager) {}

  async debit(
    walletId: string,
    amount: Money,
  ): Promise<Wallet> {
    return this.em.transactional(async (transactionEm) => {
      const repository = new MikroOrmWalletRepository(transactionEm);

      const wallet = await repository.findByIdForUpdate(walletId);

      if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
      }

      wallet.debit(amount);

      await repository.save(wallet);

      return wallet;
    });
  }

  async credit(
    walletId: string,
    amount: Money,
  ): Promise<Wallet> {
    return this.em.transactional(async (transactionEm) => {
      const repository = new MikroOrmWalletRepository(transactionEm);

      const wallet = await repository.findByIdForUpdate(walletId);

      if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
      }

      wallet.credit(amount);

      await repository.save(wallet);

      return wallet;
    });
  }
}
