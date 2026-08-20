import pg from "pg";
import { migrate } from "./migrations.js";

const { Pool } = pg;

export class EventStore {
  constructor({ connectionString, pool } = {}) {
    this.pool = pool || new Pool({ connectionString });
  }

  migrate(directory) {
    return migrate(this.pool, directory);
  }

  async createOrder(event) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO orders (id, reservation_id, idempotency_key, created_at) VALUES ($1, $2, $3, $4)",
        [event.orderId, event.reservationId, event.idempotencyKey, event.createdAt],
      );
      await client.query(
        `INSERT INTO outbox_events (id, aggregate_id, event, created_at)
         VALUES ($1, $2, $3::jsonb, $4)`,
        [event.eventId, event.orderId, JSON.stringify(event), event.createdAt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claim() {
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT id FROM outbox_events
         WHERE (status = 'PENDING' AND next_attempt_at <= now())
            OR (status = 'PUBLISHING' AND claimed_at < now() - interval '30 seconds')
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE outbox_events AS outbox
       SET status = 'PUBLISHING', claimed_at = now(), attempt_count = attempt_count + 1
       FROM candidate
       WHERE outbox.id = candidate.id
       RETURNING outbox.event, outbox.attempt_count`,
    );
    if (!result.rows[0]) return null;
    return { event: result.rows[0].event, attemptCount: result.rows[0].attempt_count };
  }

  markPublished(eventId) {
    return this.pool.query(
      "UPDATE outbox_events SET status = 'PUBLISHED', published_at = now(), claimed_at = NULL, failure_reason = NULL WHERE id = $1 AND status = 'PUBLISHING'",
      [eventId],
    );
  }

  retry(eventId, delayMs, reason) {
    return this.pool.query(
      `UPDATE outbox_events
       SET status = 'PENDING', next_attempt_at = now() + ($2 * interval '1 millisecond'), claimed_at = NULL, failure_reason = $3
       WHERE id = $1 AND status = 'PUBLISHING'`,
      [eventId, delayMs, reason],
    );
  }

  deadLetter(eventId, reason) {
    return this.pool.query(
      "UPDATE outbox_events SET status = 'DEAD_LETTER', claimed_at = NULL, failure_reason = $2 WHERE id = $1 AND status = 'PUBLISHING'",
      [eventId, reason],
    );
  }

  close() {
    return this.pool.end();
  }
}
