import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { InjectRepository } from '@nestjs/typeorm';
import {
  getWorkoutImagesBucket,
  RawUploadDocument,
  uploadWorkoutImage,
  Workout,
  WorkoutSource,
  WorkoutStatus,
  WorkoutUploadedEvent,
  WORKOUT_UPLOADED_ROUTING_KEY,
} from '@workout-logging/shared';
import { Connection, Model } from 'mongoose';
import { Repository } from 'typeorm';
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

@Injectable()
export class IngestionService {
  constructor(
    @InjectRepository(Workout) private readonly workoutRepository: Repository<Workout>,
    @InjectModel('RawUpload') private readonly rawUploadModel: Model<RawUploadDocument>,
    @InjectConnection() private readonly mongoConnection: Connection,
    private readonly publisher: RabbitMqPublisherService,
  ) {}

  async ingest(input: IngestInput): Promise<IngestResult> {
    const hasText = !!input.text;
    const hasImage = !!input.imageBuffers && input.imageBuffers.length > 0;
    if (!hasText && !hasImage) {
      throw new BadRequestException('at least one of text or images is required');
    }

    // Transient storage (research.md #11): images live in GridFS only until
    // the workout reaches a terminal status (parser worker deletes them then)
    // — never retained long-term. Uploaded before the raw_uploads doc so a
    // GridFS failure surfaces as a clean 500 rather than a doc with dangling refs.
    const workoutImageBucket = getWorkoutImagesBucket(this.mongoConnection);
    const imageRefs = input.imageBuffers
      ? await Promise.all(
          input.imageBuffers.map((buffer, index) =>
            uploadWorkoutImage(workoutImageBucket, buffer, `image-${index}`),
          ),
        )
      : [];

    const rawUpload = await this.rawUploadModel.create({
      user_id: input.userId,
      text: input.text ?? null,
      image_refs: imageRefs,
      ai_response_raw: null,
    });

    const workout = await this.workoutRepository.save(
      this.workoutRepository.create({
        userId: input.userId,
        source: input.source,
        hasText,
        hasImage,
        rawInputRef: rawUpload._id.toString(),
        status: WorkoutStatus.PENDING,
        performedAt: input.performedAt ?? new Date(),
        performedAtExplicit: !!input.performedAt,
      }),
    );

    const event: WorkoutUploadedEvent = {
      event_id: randomUUID(),
      user_id: input.userId,
      workout_id: workout.id,
      raw_upload_ref: rawUpload._id.toString(),
      occurred_at: new Date().toISOString(),
    };
    this.publisher.publish(WORKOUT_UPLOADED_ROUTING_KEY, event);

    // performedAt is returned, not just stored: when the caller omits it this
    // is the only way to learn the date the workout actually landed on, and a
    // client that guessed would be duplicating the `?? new Date()` above.
    // Note it can still move later — the parser overwrites it with a date
    // found in the text when performedAtExplicit is false
    // (apps/worker parser/handler.ts), which is the live-updates problem
    // (specs/003 FR-013), not something this response can cover.
    return { workoutId: workout.id, status: workout.status, performedAt: workout.performedAt };
  }
}
