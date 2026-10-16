import type {
  ClaimedOutboxEvent,
} from '../../infrastructure/persistence/repositories/mikro-orm-outbox.repository.js';

export interface OutboxEventPublisher {
  publish(event: ClaimedOutboxEvent): Promise<void>;
}
