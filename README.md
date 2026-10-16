# Jungle Financial Service

A financial transaction processing service for an iGaming platform, built with **NestJS**, **TypeScript**, **Bun**, **PostgreSQL**, **MikroORM**, and **AWS SQS FIFO** (via LocalStack for local development).

> **Project status:** Core financial use cases, persistence, messaging infrastructure, and HTTP endpoints are implemented. BET, WIN, and LOSS have been exercised through HTTP; REFUND and ROLLBACK HTTP flows and end-to-end messaging still require final verification. This README describes the current implementation, not a production-readiness certification.

## Overview

The service processes provider-originated wager transactions against player wallets. Its design emphasizes financial correctness under retries, concurrent requests, process crashes, and multiple service instances.

Key properties:

- Monetary amounts are represented using decimal-safe values (`decimal.js`), not JavaScript floating-point arithmetic.
- Wallet mutations and ledger entries are committed within a PostgreSQL transaction.
- Wallet rows are locked during balance-changing operations to prevent lost updates.
- Provider transaction identity and idempotency are persisted in the database.
- The ledger is append-only, with database-enforced constraints and immutability protections.
- Integration events are persisted using a **Transactional Outbox** and published asynchronously.
- An **Inbox** provides durable consumer-side deduplication.
- Pending references can be retried when their original transaction becomes available.

## Technology stack

| Area | Technology |
| --- | --- |
| HTTP API | NestJS, TypeScript |
| Runtime / package manager | Bun |
| Database | PostgreSQL 16 |
| ORM and migrations | MikroORM (EntitySchema) |
| Monetary arithmetic | decimal.js |
| Message transport | AWS SQS FIFO |
| Local message broker emulation | LocalStack |
| Infrastructure | Docker |
| Tests | Bun test runner |

## Architecture

The codebase separates domain rules from application orchestration and infrastructure:

```text
src/
├── domain/
│   ├── entities/                 # Wallet, wager transaction, ledger entry
│   └── value-objects/            # Money
├── application/
│   ├── use-cases/                # BET, WIN, LOSS, REFUND, ROLLBACK, resolution
│   └── services/                 # Outbox, inbox, reconciliation, recovery
├── infrastructure/
│   ├── persistence/              # MikroORM repositories, entities, migrations
│   └── messaging/                # SQS publisher/consumer and workers
├── interfaces/
│   └── http/                     # NestJS controller, DTOs, module
├── app.module.ts
├── main.ts
└── mikro-orm.config.ts
```

The HTTP layer delegates to application use cases. The use cases coordinate domain entities and repositories, while PostgreSQL provides the transactional boundary and database-level invariants.

## Financial operations

| Operation | Wallet effect | Ledger effect | Notes |
| --- | --- | --- | --- |
| `BET` | Debit | One `DEBIT` | Rejects insufficient balance |
| `WIN` | Credit | One `CREDIT` | Can belong to the same round as a BET |
| `LOSS` | None | None | Records the outcome only |
| `REFUND` | Credit | One `CREDIT` | Reverses an eligible processed BET once |
| `ROLLBACK` | Inverse of reference | One inverse entry | Reverses an eligible processed BET, WIN, or REFUND |

Rejected transactions do not change wallet balances or produce ledger entries. Repeated requests with the same idempotency identity and matching payload return the original result without applying the financial effect again.

### Reference handling

REFUND and ROLLBACK identify their target using `providerId` and `referenceExternalTransactionId`. Reference validation checks ownership and transaction context (provider, player, wallet, currency, and round), as well as eligible status and reversal rules. An unresolved reference may be recorded as `PENDING_REFERENCE` and retried later.

Partial reversals are outside the current scope.

## Consistency and failure recovery

### Concurrency and ledger

- Wallet updates execute inside database transactions and use row-level locking.
- Balance-changing operations write a matching immutable ledger entry.
- Database constraints enforce key uniqueness and prevent invalid wallet balances.
- The reconciliation service compares the materialized wallet balance against the net ledger total.
- A global application lock is not required.

### Transactional Outbox

Transaction state, wallet changes, ledger entries, and outbox records are persisted atomically. The publisher processes committed outbox records and sends them to SQS FIFO. Publishing is **at least once**: a crash after publish but before marking an event as delivered can cause a duplicate, so consumers must be idempotent.

Event types include:

- `WagerTransactionProcessed`
- `WagerTransactionRejected`
- `WagerTransactionPendingReference`
- `WalletBalanceChanged` (only when the wallet balance changes)

### Inbox and pending-reference recovery

The Inbox records consumed message identities in PostgreSQL to suppress duplicate processing. The current SQS consumer includes the inbox/deduplication infrastructure; its example event handler logs messages and is **not** a complete downstream business integration.

A separate recovery service periodically scans resolvable `PENDING_REFERENCE` records and retries the corresponding REFUND/ROLLBACK logic. Recovery is designed to tolerate re-execution.

## Local prerequisites

- Bun (project tested with Bun 1.4.x)
- Node.js (for tooling where applicable)
- Docker with PostgreSQL and LocalStack containers
- PowerShell or another shell

The development setup used PostgreSQL container `jungle-postgres` and LocalStack container `jungle-localstack`. Check the repository's Docker configuration before starting containers: container creation and queue bootstrap commands depend on the local setup.

## Configuration

Create a `.env` file in the project root. The database configuration reads these variables:

```dotenv
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_USER=<your_database_user>
DATABASE_PASSWORD=<your_database_password>
DATABASE_NAME=jungle_financial
PORT=3000
```

The SQS publisher/consumer may require additional AWS region, credentials, endpoint, and queue URL variables. Check the configuration in `src/infrastructure/messaging/` and supply values appropriate for AWS or LocalStack.

**Never commit `.env`, passwords, or production credentials.** Use a separate database for integration tests.

## Install and run

```powershell
bun install --frozen-lockfile
bunx mikro-orm migration:up
bun --bun run start:dev
```

> The migration command targets the database configured by the current environment. Verify `DATABASE_NAME` before applying migrations. On Windows, `bun --bun run start:dev` was used successfully after repairing an inconsistent dependency installation.

The HTTP server listens on port `3000` by default.

### Use the test database without editing `.env`

In the terminal used to launch the API:

```powershell
$env:DATABASE_NAME = "jungle_financial_test"
bun --bun run start:dev
```

The environment variable takes precedence over the `.env` default in the current configuration. Use a dedicated test database with migrated tables and seeded test wallets.

## HTTP API

| Method | Route | Description |
| --- | --- | --- |
| POST | `/transactions/bet` | Debit a wallet for a wager |
| POST | `/transactions/win` | Credit a wallet for a win |
| POST | `/transactions/loss` | Record a loss without changing balance |
| POST | `/transactions/refund` | Refund an eligible BET |
| POST | `/transactions/rollback` | Reverse an eligible transaction |

### Example: BET

```http
POST /transactions/bet
Content-Type: application/json
```

```json
{
  "walletId": "ae93a283-ebd3-440a-bb8a-cda4491a289b",
  "providerId": "provider-http-test",
  "externalTransactionId": "bet-http-001",
  "idempotencyKey": "bet-http-001",
  "payloadHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "playerId": "test-player-45413e24-cc5f-4da1-a3e6-f2bb986af4fd",
  "roundId": "round-http-001",
  "gameId": "game-http-001",
  "amount": "30.00",
  "currency": "BRL"
}
```

Example successful response:

```json
{
  "transactionId": "3e4c889d-5d4a-4e55-bb4b-bc7292bdd58d",
  "status": "PROCESSED",
  "balance": "70.00",
  "idempotentReplay": false
}
```

Sending the **same request again** should return the original transaction with `idempotentReplay: true` and must not debit the wallet again.

### REFUND / ROLLBACK payloads

Both reversal endpoints use the same base fields plus:

```json
{
  "referenceExternalTransactionId": "bet-http-001"
}
```

This is an **additional field**, not a complete request body. The referenced transaction must satisfy the business rules.

### Input validation

- `walletId` must be a UUID.
- `amount` must be a decimal **string** with two fractional digits, for example `"30.00"`.
- `currency` must be a three-letter uppercase code such as `BRL`.
- `payloadHash` is currently accepted as a 64-character hexadecimal string.
- Unknown DTO properties and invalid input types are rejected with HTTP `400`.

**Important:** the current API accepts `payloadHash` from the caller. Before production deployment, compute a canonical payload hash server-side and authenticate/authorize providers. Business exceptions also require a reviewed mapping to appropriate HTTP status codes.

## Tests

Run all tests:

```powershell
bun test
```

Check TypeScript:

```powershell
bunx tsc --noEmit
```

The project previously passed **88 tests across 22 files**. Re-run the suite before submission; that count is a historical result, not a claim about the current checkout.

Coverage includes financial rules, concurrent BET processing, idempotent replay, inbox deduplication, and pending-reference recovery. Integration tests require the configured PostgreSQL test database and relevant schema migrations.

### Manual HTTP checks completed

- BET: `100.00 -> 70.00`, one `DEBIT` ledger entry.
- BET replay: same transaction ID, `idempotentReplay: true`, no second debit.
- WIN: `70.00 -> 90.00`, one `CREDIT` ledger entry.
- LOSS: reported successful without balance or ledger change.
- Outbox: transaction and balance-change events observed in `PENDING` state for BET and WIN.

## Background workers

The repository includes standalone scripts for:

- Outbox publication to SQS FIFO (`src/infrastructure/messaging/run-outbox-worker.ts`).
- SQS inbox consumption (`src/infrastructure/messaging/run-sqs-consumer.ts`).
- One-off pending-reference recovery (`src/infrastructure/messaging/run-pending-reference-recovery.ts`).
- Periodic pending-reference recovery (`src/infrastructure/messaging/run-pending-reference-recovery-worker.ts`).

Confirm the script invocation mechanism and environment variables in your checkout before running these against a non-test database.

## Remaining verification / production hardening

1. Complete end-to-end HTTP tests for REFUND and ROLLBACK, including duplicate reversals and invalid references.
2. Verify SQS publish/consume/retry behavior end-to-end under failures and duplicate delivery.
3. Implement provider authentication/authorization and server-generated canonical payload hashes.
4. Map domain failures and idempotency conflicts to deliberate HTTP error responses.
5. Review operational observability, secrets handling, deployment configuration, and recovery of poison messages.
6. Run the complete test suite and verify migrations from a clean database before submission.

## Design trade-offs

The materialized wallet balance supports efficient reads, while the immutable ledger remains the auditable source for reconciliation. PostgreSQL row locks serialize updates to a single wallet without imposing a global lock across unrelated wallets. The Outbox decouples database commit from external message delivery, accepting at-least-once publication rather than attempting an unsafe distributed transaction.

---

**Technical challenge project — Jungle Gaming.**
