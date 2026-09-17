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
import { RabbitMqPublisherService } from '../events/rabbitmq-publisher.service';

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
 *                          -> storeOrUndo()            [the rollback boundary]
 *                               uploadWorkoutImage()   (GridFS,     shared/db/gridfs.ts)
 *                               rawUploadModel.create()(Mongo)
 *                               workoutRepository.save()(Postgres)
 *                               publisher.publish()    (RabbitMQ,   events/rabbitmq-publisher.service.ts)
 *                             on any failure -> undo() -> 503, nothing stored
 *                          -> notification.publish()   [outside the boundary]
 * ```
 *
 * The ordering inside `storeOrUndo` is not arbitrary and must not be
 * rearranged: each step needs the id the previous one produced, and `undo`
 * walks the same list backwards.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @InjectRepository(Workout) private readonly workoutRepository: Repository<Workout>,
    @InjectModel('RawUpload') private readonly rawUploadModel: Model<RawUploadDocument>,
    @InjectConnection() private readonly mongoConnection: Connection,
    private readonly publisher: RabbitMqPublisherService,
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
   * half-written workout. The half that mattered for spec 004 is the last step
   * — since T054 an unacknowledged publish raises instead of vanishing, and
   * without this the row would already be saved when it does, leaving a
   * `pending` workout no parser will ever pick up. That workout sits in the
   * in-flight surface forever, which SC-012 forbids.
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
    let workoutId: string | null = null;

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
      rawUploadId = rawUpload._id.toString();

      const workout = await this.workoutRepository.save(
        this.workoutRepository.create({
          userId: input.userId,
          source: input.source,
          hasText,
          hasImage,
          rawInputRef: rawUploadId,
          status: WorkoutStatus.PENDING,
          performedAt: input.performedAt ?? new Date(),
          performedAtExplicit: !!input.performedAt,
        }),
      );
      workoutId = workout.id;

      const event: WorkoutUploadedEvent = {
        event_id: randomUUID(),
        user_id: input.userId,
        workout_id: workout.id,
        raw_upload_ref: rawUploadId,
        occurred_at: new Date().toISOString(),
      };
      await this.publisher.publish(WORKOUT_UPLOADED_ROUTING_KEY, event);

      return workout;
    } catch (err) {
      this.logger.error(
        `ingest failed, undoing what was written (workout=${workoutId ?? 'none'}, rawUpload=${rawUploadId ?? 'none'}, images=${imageRefs.length})`,
        err instanceof Error ? err.stack : undefined,
      );

      await this.undo(bucket, imageRefs, rawUploadId, workoutId);

      // 503, not 500: nothing is wrong with the request, and retrying it is
      // exactly the right thing for the caller to do — which is only true
      // because `undo` ran first. Before this method existed, a retry would
      // have produced a duplicate workout.
      throw new ServiceUnavailableException('Could not store the workout. Nothing was saved.');
    }
  }

  /**
   * Reverse the writes, newest first.
   *
   * **Never throws.** A failed undo must not replace the original error with
   * its own: the caller needs to know the ingest failed, and that the retry is
   * safe, far more than it needs to know which half of the cleanup did not
   * land. Each step is independent so one failure does not skip the rest.
   *
   * **The decision this records** (required by T056): if the compensation
   * itself fails — Mongo goes away between the write and the rollback — the
   * orphan is logged and accepted. Nothing retries it today. That is a real,
   * chosen limit rather than an oversight: the orphan is a blob or a row that
   * nothing references and nothing serves, so it costs storage and no
   * correctness, and the alternative (a durable cleanup queue) is a second
   * outbox to justify what is already the rarer half of a rare case. The
   * `workouts` row is undone first precisely because it is the only one of the
   * three a *user* can see; if the sequence is going to break partway, it
   * should break on the invisible end.
   */
  private async undo(
    bucket: ReturnType<typeof getWorkoutImagesBucket>,
    imageRefs: string[],
    rawUploadId: string | null,
    workoutId: string | null,
  ): Promise<void> {
    if (workoutId) {
      try {
        await this.workoutRepository.delete(workoutId);
      } catch (err) {
        this.logger.error(
          `orphaned workout row ${workoutId}: compensation failed`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

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
