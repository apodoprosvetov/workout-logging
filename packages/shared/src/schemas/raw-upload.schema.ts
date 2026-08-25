import { HydratedDocument, Schema } from 'mongoose';

// research.md #11: a single workout submission may include multiple images
// (a multi-page paper log, a Telegram album) — capped to keep a single
// vision call and a single upload bounded.
export const MAX_WORKOUT_IMAGES = 10;

// Field names are snake_case to match the stored document shape (data-model.md).
export interface RawUploadDocument {
  user_id: string;
  text: string | null;
  // GridFS file ids (db/gridfs.ts's workout_images bucket) — transient,
  // deleted by the parser worker once the workout reaches a terminal status
  // (research.md #11). Never assume these still resolve to a file.
  image_refs: string[];
  ai_response_raw: unknown;
  created_at: Date;
}

export const RAW_UPLOAD_COLLECTION = 'raw_uploads';

export const RawUploadSchema = new Schema<RawUploadDocument>(
  {
    user_id: { type: String, required: true, index: true },
    text: { type: String, default: null },
    image_refs: { type: [String], default: [] },
    ai_response_raw: { type: Schema.Types.Mixed, default: null },
    created_at: { type: Date, default: Date.now },
  },
  { collection: RAW_UPLOAD_COLLECTION, versionKey: false },
);

// At least one of text/image_refs must be present (research.md #8, #11).
RawUploadSchema.pre('validate', function (this: HydratedDocument<RawUploadDocument>, next) {
  if (!this.text && this.image_refs.length === 0) {
    next(new Error('raw_uploads requires at least one of text or image_refs'));
    return;
  }
  if (this.image_refs.length > MAX_WORKOUT_IMAGES) {
    next(new Error(`raw_uploads allows at most ${MAX_WORKOUT_IMAGES} images`));
    return;
  }
  next();
});
