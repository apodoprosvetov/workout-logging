import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { InjectRepository } from '@nestjs/typeorm';
import { Connection, Model } from 'mongoose';
import { Repository } from 'typeorm';

import {
  deleteWorkoutImages,
  getWorkoutImagesBucket,
  OutboxEvent,
  RawUploadDocument,
  uploadWorkoutImage,
  Workout,
  WorkoutSource,
  WorkoutStatus,
  WorkoutUploadedEvent,
  WORKOUT_UPLOADED_ROUTING_KEY,
  ChangeNotification,
  WORKOUT_CREATED_KEY,
} from '@workout-logging/shared';

import { NotificationsPublisher } from '../events/notifications.publisher';

export interface IngestInput {
  userId: string;
  text?: string;
  imageBuffers?: Buffer[];
  performedAt?: Date;
  source: WorkoutSource;
}

export interface IngestResult {
  workoutId: string;
  status: WorkoutStatus;
  /** The date the workout was stored under — the caller's, or the default. */
  performedAt: Date;
}

/**
 * Accepts an upload and hands it to the parser.
 *
 * ```
 * POST /workouts        -> ingest()
 *                          -> storeOrUndo()             [the rollback boundary]
 *                               uploadWorkoutImage()    (GridFS)
 *                               rawUploadModel.create() (Mongo)
 *                               manager.transaction():  (Postgres, one commit)
 *                                   save(Workout)
 *                                   insert(OutboxEvent)
 *                             on any failure -> undo() -> 503, nothing stored
 *                          -> notification.publish()    [outside the boundary]
 * ```
 *
 * **Nothing here publishes to RabbitMQ** — the request path only writes the
 * outbox row; OutboxRelayService puts it on the exchange. A reader tracing why
 * a workout never parsed should look there.
 *
 * The order inside `storeOrUndo` must not be rearranged: each step needs the
 * previous one's id, and `undo` walks the Mongo half backwards.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @InjectRepository(Workout) private readonly workoutRepository: Repository<Workout>,
    @InjectModel('RawUpload') private readonly rawUploadModel: Model<RawUploadDocument>,
    @InjectConnection() private readonly mongoConnection: Connection,
    private readonly notification: NotificationsPublisher,
  ) {}

  async ingest(input: IngestInput): Promise<IngestResult> {
    const hasText = !!input.text;
    const hasImage = !!input.imageBuffers && input.imageBuffers.length > 0;
    if (!hasText && !hasImage) {
      throw new BadRequestException('at least one of text or images is required');
    }

    const workout = await this.storeOrUndo(input, hasText, hasImage);

    // Deliberately *outside* the rollback boundary above, and this is the one
    // placement decision in this method worth arguing about.
    //
    // FR-030: delivery of a notification must never be able to fail the change
    // it describes. `publishNotification` already guarantees it never throws,
    // so putting this inside the `try` would be harmless today — and wrong
    // tomorrow, because the boundary would then depend on a promise made in
    // another package rather than on where the code sits. A workout that is
    // durably stored must stay stored even if every notification path is
    // broken.
    const notification: ChangeNotification = {
      type: WORKOUT_CREATED_KEY,
      event_id: randomUUID(),
      user_id: input.userId,
      occurred_at: new Date().toISOString(),
      workout_id: workout.id,
      performed_at: workout.performedAt.toISOString(),
    };
    await this.notification.publish(notification);

    // Returned because when the caller omits it this is the only way to learn
    // where the workout landed. It can still move later: the parser overwrites
    // it with a date found in the text when performedAtExplicit is false.
    return { workoutId: workout.id, status: workout.status, performedAt: workout.performedAt };
  }

  /**
   * The writes and their undo, so the caller sees "it worked" or "it failed",
   * never a half-written workout.
   *
   * A compensating action, not a saga: one method drives the sequence and its
   * reversal, with no second participant. It survives the outbox because it
   * covers the cross-database half — GridFS and `raw_uploads` are written
   * before a Postgres transaction that can still fail, and no transaction
   * spans both databases.
   */
  private async storeOrUndo(
    input: IngestInput,
    hasText: boolean,
    hasImage: boolean,
  ): Promise<Workout> {
    const bucket = getWorkoutImagesBucket(this.mongoConnection);

    // Everything created so far, in creation order. `undo` walks it backwards.
    const imageRefs: string[] = [];
    let rawUploadId: string | null = null;

    try {
      // Transient storage (research.md #11): images live in GridFS only until
      // the workout reaches a terminal status, when the parser worker deletes
      // them — never retained long-term.
      //
      // `allSettled`, not `all`: a rejecting `all` discards the refs of the
      // uploads that *did* succeed, and those blobs are then unreachable —
      // no raw_uploads doc will ever name them. Collecting every fulfilled ref
      // before rethrowing is what lets `undo` clean up a partial upload, which
      // a plain `all` made structurally impossible.
      const uploads = await Promise.allSettled(
        (input.imageBuffers ?? []).map((buffer, index) =>
          uploadWorkoutImage(bucket, buffer, `image-${index}`),
        ),
      );
      for (const result of uploads) {
        if (result.status === 'fulfilled') imageRefs.push(result.value);
      }
      const failed = uploads.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;

      const rawUpload = await this.rawUploadModel.create({
        user_id: input.userId,
        text: input.text ?? null,
        image_refs: imageRefs,
        ai_response_raw: null,
      });
      // Two names: `rawUploadRef` is a `string` the compiler sees, `rawUploadId`
      // the outer `string | null` the compensation reads on a later throw.
      const rawUploadRef = rawUpload._id.toString();
      rawUploadId = rawUploadRef;

      // The workout row and its event commit together or not at all —
      // Principle IV made structural: there is no ordering left to get wrong.
      //
      // `workoutRepository.manager` rather than an injected DataSource: same
      // connection, one fewer constructor dependency.
      const workout = await this.workoutRepository.manager.transaction(async (manager) => {
        const saved = await manager.save(
          manager.create(Workout, {
            userId: input.userId,
            source: input.source,
            hasText,
            hasImage,
            rawInputRef: rawUploadRef,
            status: WorkoutStatus.PENDING,
            performedAt: input.performedAt ?? new Date(),
            performedAtExplicit: !!input.performedAt,
          }),
        );

        const occurredAt = new Date();
        const event: WorkoutUploadedEvent = {
          event_id: randomUUID(),
          user_id: input.userId,
          workout_id: saved.id,
          raw_upload_ref: rawUploadRef,
          occurred_at: occurredAt.toISOString(),
        };

        // `insert`, not `save`: the primary key is supplied rather than
        // generated, so `save` would issue a SELECT first to decide between
        // INSERT and UPDATE. This table is append-only and the id is a fresh
        // uuid every time, so that round-trip buys nothing — and an UPDATE
        // here would be a bug quietly papered over.
        //
        // `occurred_at` is written twice on purpose: once as a column the
        // relay orders by, and once inside the payload, because the payload is
        // the wire envelope consumers actually read and it must stay whole.
        await manager.insert(OutboxEvent, {
          eventId: event.event_id,
          routingKey: WORKOUT_UPLOADED_ROUTING_KEY,
          payload: event,
          occurredAt,
          publishedAt: null,
        });

        return saved;
      });

      return workout;
    } catch (err) {
      this.logger.error(
        `ingest failed, undoing the Mongo writes (rawUpload=${rawUploadId ?? 'none'}, images=${imageRefs.length})`,
        err instanceof Error ? err.stack : undefined,
      );

      await this.undo(bucket, imageRefs, rawUploadId);

      // 503, not 500: the request is fine and retrying is right — which is only
      // true because nothing survives a failure.
      throw new ServiceUnavailableException('Could not store the workout. Nothing was saved.');
    }
  }

  /**
   * Reverse the **Mongo** writes, newest first. Postgres rolls itself back now,
   * but an outbox spans one database — the GridFS blobs and `raw_uploads` doc
   * written before the transaction are still this method's job.
   *
   * **Never throws.** A failed undo must not replace the original error: the
   * caller needs "it failed, retrying is safe" far more than it needs to know
   * which half of the cleanup missed. Each step is independent.
   *
   * **If the compensation itself fails, the orphan is logged and accepted** —
   * a chosen limit, not an oversight: it costs storage and no correctness, and
   * a durable cleanup queue would be a second outbox for the rarer half of a
   * rare case.
   */
  private async undo(
    bucket: ReturnType<typeof getWorkoutImagesBucket>,
    imageRefs: string[],
    rawUploadId: string | null,
  ): Promise<void> {
    if (rawUploadId) {
      try {
        await this.rawUploadModel.deleteOne({ _id: rawUploadId });
      } catch (err) {
        this.logger.error(
          `orphaned raw_uploads doc ${rawUploadId}: compensation failed`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

    if (imageRefs.length > 0) {
      try {
        await deleteWorkoutImages(bucket, imageRefs);
      } catch (err) {
        this.logger.error(
          `orphaned GridFS blobs ${imageRefs.join(', ')}: compensation failed`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }
  }
}
