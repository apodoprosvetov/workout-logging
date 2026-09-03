import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import amqplib, { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import {
  WORKOUT_ANALYTICS_QUEUE,
  WORKOUT_DLQ,
  WORKOUT_EVENTS_EXCHANGE,
  WORKOUT_PARSE_QUEUE,
  WORKOUT_PARSED_ROUTING_KEY,
  WORKOUT_UPLOADED_ROUTING_KEY,
} from './types';

// CLI convenience only — no-op once a real process (apps/api, apps/worker) has already loaded its own env.
if (!process.env.RABBITMQ_URL) {
  loadEnv({ path: path.resolve(__dirname, '../../../../.env') });
}

export const rabbitmqUrl = process.env.RABBITMQ_URL as string;

// Backoff tiers (research.md #3): 3 retry attempts, 5s / 30s / 5m apart, before workout.dlq.
const RETRY_TIERS = [
  { label: '5s', delayMs: 5_000 },
  { label: '30s', delayMs: 30_000 },
  { label: '5m', delayMs: 300_000 },
] as const;

export interface RetryTier {
  attempt: number;
  delayMs: number;
  queue: string;
}

// e.g. workout.parse.q.retry.5s, workout.parse.q.retry.30s, workout.parse.q.retry.5m
export function retryTiersFor(primaryQueue: string): RetryTier[] {
  return RETRY_TIERS.map(({ label, delayMs }, index) => ({
    attempt: index + 1,
    delayMs,
    queue: `${primaryQueue}.retry.${label}`,
  }));
}

// The retry queue a message should be republished to after its Nth failed attempt,
// or null once retries are exhausted (caller should route to WORKOUT_DLQ instead).
export function retryQueueForAttempt(primaryQueue: string, attemptNumber: number): string | null {
  return retryTiersFor(primaryQueue)[attemptNumber - 1]?.queue ?? null;
}

// A worker sets this header when it routes a failed message to a retry tier;
// RabbitMQ preserves it across the TTL dead-letter hop (unlike the reserved
// x-death, which is stripped on any client publish — research.md #3). So the
// counter is owned by the worker, not the broker.
export const RETRY_ATTEMPT_HEADER = 'x-retry-attempt';

export function getRetryAttempt(msg: ConsumeMessage): number {
  const raw = msg.properties.headers?.[RETRY_ATTEMPT_HEADER];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

async function setupPrimaryQueue(channel: Channel, queue: string, routingKey: string): Promise<void> {
  await channel.assertQueue(queue, { durable: true });
  await channel.bindQueue(queue, WORKOUT_EVENTS_EXCHANGE, routingKey);

  // Each retry tier is a plain holding queue: its only job is to sit on a message
  // for `delayMs`, then dead-letter it back onto the primary queue via the topic
  // exchange. Workers publish into these directly (by name, via the default
  // exchange) when a delivery fails — see research.md #3 / T032.
  for (const tier of retryTiersFor(queue)) {
    await channel.assertQueue(tier.queue, {
      durable: true,
      messageTtl: tier.delayMs,
      deadLetterExchange: WORKOUT_EVENTS_EXCHANGE,
      deadLetterRoutingKey: routingKey,
    });
  }
}

export async function setupRabbitMqTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(WORKOUT_EVENTS_EXCHANGE, 'topic', { durable: true });
  await setupPrimaryQueue(channel, WORKOUT_PARSE_QUEUE, WORKOUT_UPLOADED_ROUTING_KEY);
  await setupPrimaryQueue(channel, WORKOUT_ANALYTICS_QUEUE, WORKOUT_PARSED_ROUTING_KEY);
  // Final dead-letter queue — workers publish here directly once retries are exhausted.
  await channel.assertQueue(WORKOUT_DLQ, { durable: true });
}

export async function connectRabbitMq(): Promise<ChannelModel> {
  return amqplib.connect(rabbitmqUrl);
}
