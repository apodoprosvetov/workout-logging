import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

import { logLine } from '@workout-logging/shared';

// HttpException (NotFoundException, UnauthorizedException, ...) pass through as
// their declared status. Any 5xx — a thrown InternalServerErrorException or a
// genuinely unhandled error — is logged server-side with request context (the
// client only ever sees a generic 500, no stack). 4xx are the caller's problem
// and are left to the request-logging interceptor's `warn` line.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const req = http.getRequest<FastifyRequest & { userId?: string }>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= 500) {
      logLine('api', 'error', 'unhandled exception', {
        type: 'exception',
        method: req.method,
        path: req.url,
        status,
        ...(req.userId ? { userId: req.userId } : {}),
        err: exception,
      });
    }

    if (exception instanceof HttpException) {
      reply.status(status).send(exception.getResponse());
      return;
    }

    reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
