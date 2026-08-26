import amqp from "amqplib";
import { setTimeout as wait } from "node:timers/promises";
import { continueTrace } from "./tracing.js";

export const eventExchange = "nimbus.orders";
export const deadLetterExchange = "nimbus.dead-letter";
export const deadLetterQueue = "nimbus.dead-letter";
export const consumers = ["payment-worker", "notification-router", "analytics-ingestor"];
export const maxConsumerAttempts = 5;
const queueName = (consumer) => `nimbus.${consumer}`;

export async function declareTopology(channel) {
  await channel.assertExchange(eventExchange, "fanout", { durable: true });
  await channel.assertExchange(deadLetterExchange, "fanout", { durable: true });
  await channel.assertQueue(deadLetterQueue, { durable: true, arguments: { "x-queue-type": "quorum" } });
  await channel.bindQueue(deadLetterQueue, deadLetterExchange, "");
  for (const consumer of consumers) {
    const queue = queueName(consumer);
    await channel.assertQueue(queue, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": deadLetterExchange,
      },
    });
    await channel.bindQueue(queue, eventExchange, "");
  }
}

export async function publishConfirmed(channel, event) {
  channel = await channel;
  channel.publish(eventExchange, "", Buffer.from(JSON.stringify(event)), {
    persistent: true,
    contentType: "application/json",
    messageId: event.eventId,
    correlationId: event.correlationId,
    headers: event.traceContext,
  });
  await channel.waitForConfirms();
}

function parseEvent(message) {
  const event = JSON.parse(message.content.toString());
  const strings = ["eventId", "correlationId", "idempotencyKey", "type", "createdAt", "orderId", "reservationId"];
  if (strings.some((field) => typeof event[field] !== "string" || !event[field]) || !Number.isInteger(event.version) || event.version < 1) throw new Error("invalid event envelope");
  if (event.traceContext && (typeof event.traceContext !== "object" || Array.isArray(event.traceContext) || Object.entries(event.traceContext).some(([key, value]) => !["traceparent", "tracestate"].includes(key) || typeof value !== "string"))) throw new Error("invalid trace context");
  return event;
}

export async function handleDelivery(channel, message, handler, queue) {
  try {
    await handler(parseEvent(message));
    channel.ack(message);
  } catch (error) {
    const attempt = Number(message.properties?.headers?.["x-nimbus-attempt"] || 1);
    console.error(JSON.stringify({ type: "event-consumer-failed", service: process.env.SERVICE_NAME, attempt, message: error.message }));
    if (attempt >= maxConsumerAttempts) {
      try { channel.nack(message, false, false); } catch {}
      return;
    }
    try {
      channel.sendToQueue(queue, message.content, {
        ...message.properties,
        persistent: true,
        headers: { ...message.properties?.headers, "x-nimbus-attempt": attempt + 1 },
      });
      await channel.waitForConfirms();
      channel.ack(message);
    } catch {
      try { channel.nack(message, false, true); } catch {}
    }
  }
}

export class BrokerPublisher {
  constructor({ url, connect = amqp.connect }) {
    this.url = url;
    this.connect = connect;
  }

  async open() {
    if (this.channel) return this.channel;
    if (!this.opening) this.opening = (async () => {
      const connection = await this.connect(this.url);
      try {
        connection.on("error", () => {});
        connection.on("close", () => {
          if (this.connection === connection) {
            this.connection = null;
            this.channel = null;
          }
        });
        const channel = await connection.createConfirmChannel();
        await declareTopology(channel);
        this.connection = connection;
        this.channel = channel;
        return channel;
      } catch (error) {
        try { await connection.close(); } catch {}
        throw error;
      }
    })().finally(() => { this.opening = null; });
    return this.opening;
  }

  async publish(event) {
    try {
      await continueTrace(event.traceContext, () => publishConfirmed(this.open(), event));
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    const connection = this.connection;
    this.connection = null;
    this.channel = null;
    if (connection) try { await connection.close(); } catch {}
  }
}

export class BrokerConsumer {
  constructor({ url, name, handler, connect = amqp.connect, waitFor = wait }) {
    this.url = url;
    this.name = name;
    this.handler = handler;
    this.connect = connect;
    this.waitFor = waitFor;
    this.running = false;
  }

  start() {
    this.running = true;
    this.loop = this.run();
  }

  async run() {
    while (this.running) {
      let connection;
      try {
        connection = await this.connect(this.url);
        this.connection = connection;
        connection.on("error", () => {});
        const closed = new Promise((resolve) => connection.once("close", resolve));
        const channel = await connection.createConfirmChannel();
        await declareTopology(channel);
        await channel.prefetch(1);
        await channel.consume(queueName(this.name), (message) => {
          if (message) void handleDelivery(channel, message, this.handler, queueName(this.name));
        });
        await closed;
      } catch (error) {
        if (this.running) console.error(JSON.stringify({ type: "broker-consumer-error", service: this.name, message: error.message }));
      } finally {
        this.connection = null;
        if (connection) try { await connection.close(); } catch {}
      }
      if (this.running) await this.waitFor(500);
    }
  }

  async stop() {
    this.running = false;
    if (this.connection) try { await this.connection.close(); } catch {}
    await this.loop;
  }
}
