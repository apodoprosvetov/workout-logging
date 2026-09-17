import http from 'node:http';

import { httpServer } from './test-app';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AddressInfo } from 'node:net';

// supertest is no use here: it buffers until the response ends, and an SSE
// response never does. These helpers hold a real socket open instead, which is
// also the only way to observe what a *second* connection does or does not
// receive — the cross-user isolation check in events.delivery.spec.ts.

export interface SseConnection {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Everything received so far, raw. */
  readonly text: string;
  /** Resolves once `text` contains `needle`; rejects on timeout. */
  waitFor(needle: string, timeoutMs?: number): Promise<void>;
  /** Resolves after `ms` with whatever arrived — for asserting nothing did. */
  settle(ms: number): Promise<string>;
  close(): void;
}

/** Starts listening on an ephemeral port and returns it. */
export async function listenOnRandomPort(app: NestFastifyApplication): Promise<number> {
  await app.listen(0, '127.0.0.1');
  const address = (httpServer(app) as http.Server).address() as AddressInfo;
  return address.port;
}

export function openSse(
  port: number,
  token: string | null,
  path = '/api/events',
): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (token) headers.authorization = `Bearer ${token}`;

    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let text = '';
      const waiters: Array<{ needle: string; resolve: () => void }> = [];

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (text.includes(waiters[i].needle)) {
            waiters[i].resolve();
            waiters.splice(i, 1);
          }
        }
      });

      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        get text() {
          return text;
        },
        waitFor(needle: string, timeoutMs = 5000) {
          if (text.includes(needle)) return Promise.resolve();
          return new Promise<void>((ok, fail) => {
            const timer = setTimeout(
              () => fail(new Error(`timed out waiting for ${needle}; got: ${text.slice(0, 300)}`)),
              timeoutMs,
            );
            waiters.push({
              needle,
              resolve: () => {
                clearTimeout(timer);
                ok();
              },
            });
          });
        },
        settle(ms: number) {
          return new Promise<string>((ok) => setTimeout(() => ok(text), ms));
        },
        close() {
          req.destroy();
        },
      });
    });

    req.on('error', reject);
    req.end();
  });
}
