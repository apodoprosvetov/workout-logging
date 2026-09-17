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
 * Call order, since this spans three systems and two other files:
 *
 * ```
 * POST /workouts        -> ingest()
 *                          -> storeOrUndo()             [the rollback boundary]
 *                               uploadWorkoutImage()    (GridFS,   shared/db/gridfs.ts)
 *                               rawUploadModel.create() (Mongo)
 *                               manager.transaction():  (Postgres, one commit)
 *                                   save(Workout)
 *                                   insert(OutboxEvent)
 *                             on any failure -> undo() -> 503, nothing stored
 *                          -> notification.publish()    [outside the boundary]
 * ```
 *
 * **Nothing here publishes to RabbitMQ.** Since T058 the request path only
 * writes the event to the `outbox` table; the relay (T059) is what puts it on
 * the exchange, and the parser is downstream of the relay, not of this method.
 * A reader tracing why a workout never parsed should look there, not here.
 *
 * The ordering inside `storeOrUndo` is not arbitrary and must not be
 * rearranged: each step needs the id the previous one produced, and `undo`
 * walks the Mongo half backwards.
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

    // performedAt is returned, not just stored: when the caller omits it this
    // is the only way to learn the date the workout actually landed on, and a
    // client that guessed would be duplicating the `?? new Date()` above.
    // Note it can still move later — the parser overwrites it with a date
    // found in the text when performedAtExplicit is false
    // (apps/worker parser/handler.ts), which is the live-updates problem
    // (specs/003 FR-013), not something this response can cover.
    return { workoutId: workout.id, status: workout.status, performedAt: workout.performedAt };
  }

  /**
   * The four writes, and their undo.
   *
   * A **compensating action, not a saga**: one method drives the whole sequence
   * and its reversal, with no second participant and no messages between steps.
   * If it needs a label at all it is orchestration — this project's actual
   * choreography is `workout.uploaded → parser → workout.parsed → analytics`,
   * where no single place holds the overall picture.
   *
   * What it buys: the caller sees either "it worked" or "it failed", never a
   * half-written workout.
   *
   * The failure that originally motivated it — a publish that vanished, leaving
   * a `pending` workout no parser would ever pick up, stuck in the in-flight
   * surface forever against SC-012 — is gone from this path entirely as of
   * T058, because the publish is. What is left for the compensation is the
   * genuinely cross-database half: GridFS and `raw_uploads` are written before
   * a Postgres transaction that can still fail, and no transaction spans both
   * databases.
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
      // Two names for one value, and both are needed: `rawUploadRef` is a
      // `string` the compiler can see, while `rawUploadId` is the outer
      // `string | null` the compensation reads if a later step throws.
      const rawUploadRef = rawUpload._id.toString();
      rawUploadId = rawUploadRef;

      // The workout row and its event, committed together or not at all.
      //
      // This is Constitution Principle IV — "an event that drives work MUST be
      // published only after the state it describes has committed" — turned
      // from something the code is careful about into something it cannot get
      // wrong. Before this, the publish sat after the save with nothing binding
      // the two; now there is no ordering to get wrong because there is no
      // second step in the request path at all.
      //
      // `this.workoutRepository.manager`, not an injected DataSource: the
      // repository's own manager is the same connection, and routing the
      // transaction through it keeps the number of things this service has to
      // be handed at construction unchanged.
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

      // 503, not 500: nothing is wrong with the request, and retrying it is
      // exactly the right thing for the caller to do — which is only true
      // because nothing survives a failure. Before the compensation existed, a
      // retry would have produced a duplicate workout.
      throw new ServiceUnavailableException('Could not store the workout. Nothing was saved.');
    }
  }

  /**
   * Reverse the **Mongo** writes, newest first.
   *
   * Postgres is not its business any more, and that is T058's doing: the
   * workout row and its outbox event now commit or roll back together, so a
   * failure on that side leaves nothing behind for anyone to delete. What an
   * outbox cannot help with is the other database — it spans one — so the
   * GridFS blobs and the `raw_uploads` doc written before the transaction are
   * still this method's job. That asymmetry is the whole reason a compensating
   * action survives into increment 2.
   *
   * **Never throws.** A failed undo must not replace the original error with
   * its own: the caller needs to know the ingest failed, and that the retry is
   * safe, far more than it needs to know which half of the cleanup did not
   * land. Each step is independent so one failure does not skip the rest.
   *
   * **The decision this records** (required by T056): if the compensation
   * itself fails — Mongo goes away between the write and the rollback — the
   * orphan is logged and accepted. Nothing retries it today. That is a real,
   * chosen limit rather than an oversight: the orphan is a blob or a doc that
   * nothing references and nothing serves, so it costs storage and no
   * correctness, and the alternative (a durable cleanup queue) is a second
   * outbox to justify what is already the rarer half of a rare case.
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
        // Already tolerates a ref that is gone, so a partly-completed undo can
        // be re-run without special casing.
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
