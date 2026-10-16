# Jungle Financial Service

A distributed financial transaction processing service for an iGaming platform, implemented with **NestJS**, **TypeScript**, **Bun**, **PostgreSQL 16**, **MikroORM**, **decimal.js**, and **AWS SQS FIFO** (emulated locally with LocalStack).

> **Status:** Technical challenge implementation. Core financial operations, persistence, HTTP endpoints, outbox/inbox infrastructure, and pending-reference recovery are implemented. The project is **not presented as production-ready**; see [Known limitations](#known-limitations-and-next-steps) 

## Overview

The service processes provider-originated wager transactions against player wallets. It prioritizes:

- **Financial precision:** monetary amounts are decimal strings, represented using `decimal.js` rather than JavaScript floating-point arithmetic.
- **Atomicity:** transaction state, wallet balance, ledger entries, and outbox records are persisted within the same PostgreSQL transaction.
- **Concurrency safety:** row-level locks serialize mutations of a given wallet without a global lock.
- **Persistent idempotency:** provider identities and idempotency keys are stored in PostgreSQL; repeated requests must not apply money movements twice.
- **Auditability:** immutable, append-only ledger entries support balance reconciliation.
- **Asynchronous delivery:** a transactional outbox publishes events to SQS FIFO after commit; a durable inbox supports consumer deduplication.
- **Recovery:** REFUND and ROLLBACK requests with missing references may be persisted as `PENDING_REFERENCE` and retried.

## Technology stack

| Concern | Technology |
| --- | --- |
| HTTP API | NestJS, TypeScript, class-validator |
| Runtime and package manager | Bun |
| Database | PostgreSQL 16 |
| ORM / schema migrations | MikroORM with EntitySchema |
| Monetary arithmetic | decimal.js |
| Messaging | AWS SQS FIFO |
| Local SQS emulation | LocalStack |
| Local infrastructure | Docker |
| Testing | Bun test runner, real PostgreSQL integration tests |

### Source tree

The tree below highlights the principal implementation files rather than every generated file, test fixture, or migration:

```text
src/
├── application/
│   ├── ports/
│   │   └── outbox-event-publisher.ts
│   ├── services/
│   │   ├── financial-outbox.service.ts
│   │   ├── inbox-processor.service.ts
│   │   ├── outbox-worker.service.ts
│   │   ├── pending-reference-recovery.service.ts
│   │   ├── wallet-reconciliation.service.ts
│   │   └── wallet-transaction.service.ts
│   └── use-cases/
│       ├── process-bet.use-case.ts
│       ├── process-win.use-case.ts
│       ├── process-loss.use-case.ts
│       ├── process-refund.use-case.ts
│       ├── process-rollback.use-case.ts
│       ├── resolve-pending-refunds.use-case.ts
│       └── resolve-pending-rollbacks.use-case.ts
├── domain/
│   ├── entities/
│   │   ├── wallet.ts
│   │   ├── wallet-ledger-entry.ts
│   │   └── wager-transaction.ts
│   └── value-objects/
│       └── money.ts
├── infrastructure/
│   ├── persistence/
│   │   ├── entities/                  # MikroORM schemas
│   │   └── repositories/             # Wallet, ledger, wager, inbox, outbox
│   └── messaging/                    # SQS adapters and worker entry points
├── interfaces/
│   └── http/
│       ├── financial-payload-hash.ts
│       ├── financial-transaction.dto.ts
│       ├── financial.controller.ts
│       └── financial.module.ts
├── migrations/                       # Database schema migrations
├── app.module.ts
├── main.ts
├── mikro-orm.config.ts
└── mikro-orm.test.config.ts

test/                                 # Integration / concurrency tests
README.md
```

The `application` layer coordinates use cases; `domain` encapsulates money and transaction rules; `infrastructure` integrates PostgreSQL and SQS; `interfaces/http` exposes the API. The `ports` directory contains an outbound messaging abstraction.

## Financial operations

| Operation | Wallet effect | Ledger effect | Behavior |
| --- | --- | --- | --- |
| `BET` | Debit | One `DEBIT` | Rejects insufficient funds |
| `WIN` | Credit | One `CREDIT` | Records winnings |
| `LOSS` | None | None | Records the result without moving money |
| `REFUND` | Credit | One `CREDIT` | Reverses an eligible processed BET once |
| `ROLLBACK` | Inverse of referenced effect | One inverse entry | Reverses an eligible processed BET, WIN, or REFUND |

Rejected operations do not change the balance or append financial ledger entries. Partial reversals are out of scope. References are identified by `(providerId, referenceExternalTransactionId)` and validated against the player, wallet, currency, round, status, and reversal rules.

## HTTP API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/transactions/bet` | Place a wager / debit a wallet |
| `POST` | `/transactions/win` | Credit winnings |
| `POST` | `/transactions/loss` | Record a loss |
| `POST` | `/transactions/refund` | Refund a BET |
| `POST` | `/transactions/rollback` | Reverse a processed operation |

### Example: BET

```http
POST /transactions/bet
Content-Type: application/json
```

```json
{
  "walletId": "ae93a283-ebd3-440a-bb8a-cda4491a289b",
  "providerId": "provider-http-test",
  "externalTransactionId": "bet-example-001",
  "idempotencyKey": "bet-example-001",
  "playerId": "test-player-45413e24-cc5f-4da1-a3e6-f2bb986af4fd",
  "roundId": "round-example-001",
  "gameId": "game-example-001",
  "amount": "30.00",
  "currency": "BRL"
}
```

**Do not send `payloadHash`.** The HTTP controller calculates a SHA-256 hash from selected transaction fields, including the operation type. The internal application use cases still receive the computed hash.

Example successful response (assuming the wallet starts at `100.00`):

```json
{
  "transactionId": "3e4c889d-5d4a-4e55-bb4b-bc7292bdd58d",
  "status": "PROCESSED",
  "balance": "70.00",
  "idempotentReplay": false
}
```

Sending the identical request again should return the original transaction ID with `idempotentReplay: true`, without a second debit. Reusing the same idempotency identity with a different payload is rejected by the application; **HTTP mapping of that conflict to 409 is still pending** (it currently surfaces as 500 in the tested LOSS scenario).

For `REFUND` and `ROLLBACK`, include all common fields plus `referenceExternalTransactionId`:

```json
{
  "referenceExternalTransactionId": "bet-example-001"
}
```

The snippet above shows **only the additional field**, not a complete request body.

### Input validation

- `walletId`: UUID.
- `amount`: decimal **string** with exactly two fractional digits (e.g. `"30.00"`), not a JSON number.
- `currency`: three uppercase letters (e.g. `BRL`).
- Other identifiers: required strings as defined by the DTOs.
- Reversal requests: require `referenceExternalTransactionId`.

The DTO no longer declares `payloadHash`. Strict rejection of extra request fields depends on the application's configured `ValidationPipe` and should be verified separately.

## Consistency, messaging, and recovery

**Database consistency.** Balance-changing operations use PostgreSQL transactions and wallet row locks. The immutable ledger records the corresponding debit or credit; a reconciliation service compares ledger totals with the materialized wallet balance.

**Transactional outbox.** Events are written in the same commit as financial state. A separate worker publishes committed records to SQS FIFO. Publication is **at least once**, so downstream consumers must tolerate duplicates.

**Events:** `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, and `WalletBalanceChanged` (only when the balance changes).

**Inbox.** The consumer persists message identities in PostgreSQL to deduplicate processing. The current SQS consumer's example handler logs received events; it is **not** a completed downstream business integration.

**Pending references.** Recovery scans eligible `PENDING_REFERENCE` reversals and retries REFUND / ROLLBACK processing. A one-off command and a periodic worker are available.

## Local setup

### Prerequisites

- Bun (the project has been exercised with Bun 1.4.x).
- Node.js for tools that require it.
- Docker with PostgreSQL 16 and LocalStack.
- A PostgreSQL database and an SQS FIFO queue configured for this project.

The local development environment previously used containers named `jungle-postgres` and `jungle-localstack`, with queue `jungle-financial-events.fifo`. Container/queue bootstrap commands depend on the repository's Docker setup and are not assumed here.

### Environment

Create `.env` in the project root (do not commit it):

```dotenv
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_USER=<database_user>
DATABASE_PASSWORD=<database_password>
DATABASE_NAME=jungle_financial
PORT=3000
```

The messaging adapters also require SQS configuration (endpoint, region, credentials, queue URL); consult `src/infrastructure/messaging/` for the exact environment variable names used in this checkout. For local emulation, use LocalStack-specific credentials rather than production credentials.

### Install, migrate, run

```powershell
bun install --frozen-lockfile
bunx mikro-orm migration:up
bun --bun run start:dev
```

**Safety:** verify the selected `DATABASE_NAME` before migrations or manual API calls. To launch the API against the isolated test database in the current PowerShell session:

```powershell
$env:DATABASE_NAME = "jungle_financial_test"
bun --bun run start:dev
```

The test database needs its own schema migrations and seeded wallet data. Do not use a production database for integration tests.

## Tests and verification

```powershell
# Ensure the test DB guard points to the dedicated database
$env:POSTGRES_DB = "jungle_financial_test"
$env:DATABASE_NAME = "jungle_financial_test"

bun test
bunx tsc --noEmit
```

The suite includes unit/integration coverage for financial operations, concurrent bets, idempotent replay, inbox deduplication, and pending-reference recovery. **The historical result was 88 passing tests across 22 files**; execute the suite in your checkout for an up-to-date count.

Manual HTTP checks performed during development included BET, WIN, LOSS, REFUND, ROLLBACK, idempotent replays, and duplicate reversal protection. In a subsequent LOSS test, a changed payload with the same idempotency key was blocked (one persisted transaction), but the API returned HTTP 500 instead of the desired 409.

## Background workers

| Purpose | Entry point |
| --- | --- |
| Outbox publication | `src/infrastructure/messaging/run-outbox-worker.ts` |
| SQS inbox consumer | `src/infrastructure/messaging/run-sqs-consumer.ts` |
| One-off reference recovery | `src/infrastructure/messaging/run-pending-reference-recovery.ts` |
| Periodic reference recovery | `src/infrastructure/messaging/run-pending-reference-recovery-worker.ts` |

Run these using the Bun invocation appropriate for your package scripts and TypeScript configuration; check the worker entry point and environment before connecting to any non-test service.

## Known limitations and next steps

1. Map idempotency payload conflicts to **HTTP 409** consistently across all endpoints; verify the exact domain error codes and add an HTTP regression test.
2. Verify crash/retry scenarios end-to-end for SQS publication and consumption, including duplicate delivery, poison messages, DLQ configuration, and graceful shutdown.
3. Validate the financial guarantees under **multiple independent service processes**, not only concurrent calls in one process.
4. Add provider authentication/authorization, structured logs, metrics, and health checks before any production deployment.
5. Verify a clean-database migration and full integration test run in a reproducible environment.
6. Review canonical payload hashing rules for normalization (e.g. equivalent monetary representations) and compatibility with legacy test records.

---

**Technical challenge project — Jungle Gaming.**
