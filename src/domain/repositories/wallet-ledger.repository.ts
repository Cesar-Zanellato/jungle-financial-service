import type { WalletLedgerEntry } from '../entities/wallet-ledger-entry.js';

export interface WalletLedgerRepository {
  save(entry: WalletLedgerEntry): Promise<void>;

  findByTransactionId(
    transactionId: string,
  ): Promise<WalletLedgerEntry | null>;
}