import {
  Controller,
  HttpException,
  HttpStatus,
  MessageEvent,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { finalize, interval, merge, map, timer, Observable, takeUntil } from 'rxjs';

import { NotificationsSubscriber } from './notifications.subscriber';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(private readonly subscriber: NotificationsSubscriber) {}

  @Sse()
  async stream(@Req() req: AuthenticatedRequest): Promise<Observable<MessageEvent>> {
    try {
      const stream = await this.subscriber.openStream(req.userId);
      if (!stream) {
        // Per-user cap reached on this replica — contracts/api.md documents 429
        // here vs. 503 for a subscribe failure (see openStream's doc comment).
        throw new HttpException('Too many connections for this user', HttpStatus.TOO_MANY_REQUESTS);
      }
      const heartbeat$ = interval(15_000).pipe(map(() => ({ type: 'heartbeat', data: '' })));

      return merge(stream, heartbeat$).pipe(
        takeUntil(timer(req.timeLeftInSeconds * 1000)),
        // `void`: closeStream is async but nothing here can await it — finalize
        // runs synchronously as the stream tears down. Its own failures are
        // handled internally, so the promise is deliberately not chained.
        finalize(() => {
          void this.subscriber.closeStream(req.userId, stream);
        }),
      );
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      // Notification backend unavailable — contracts/api.md documents 503
      // here vs. 429 for the per-user cap (see openStream's doc comment).
      throw new HttpException('Notifications unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
