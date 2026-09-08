import { NestFastifyApplication } from '@nestjs/platform-fastify';

import { logLine } from '@workout-logging/shared';

// One structured line per HTTP request via Fastify's onResponse hook (fires
// after the response is sent, for every request — including 404s and errors,
// and CORS preflights). A Nest interceptor would miss unmatched routes and
// drags in an rxjs version-mismatch across the monorepo's two installs.
//
// `request.userId` is set by JwtAuthGuard on the same Fastify request object,
// so authenticated requests carry the user. 5xx → error, 4xx → warn, else info,
// so `docker logs | jq 'select(.level=="error")'` is a usable incident view.
export function registerRequestLogging(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onResponse', (request, reply, done) => {
    const status = reply.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    const userId = (request as { userId?: string }).userId;

    logLine('api', level, 'request', {
      type: 'request',
      method: request.method,
      path: request.url,
      status,
      durationMs: Math.round(reply.elapsedTime),
      ...(userId ? { userId } : {}),
    });
    done();
  });
}
