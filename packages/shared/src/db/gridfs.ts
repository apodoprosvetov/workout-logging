import mongoose, { type Connection } from 'mongoose';

// research.md #11: workout images are transient — kept only long enough for
// the parser worker to read them (including retries), never retained
// long-term. Stored in Mongo (already in the stack) via GridFS rather than
// inline in raw_uploads, since a single doc is capped at 16MB and a
// submission can carry up to MAX_WORKOUT_IMAGES unrestricted-size images
// (spec.md Clarifications Q4 — no size limits enforced).
export const WORKOUT_IMAGES_BUCKET = 'workout_images';

// Imported off `mongoose.mongo` (not the `mongodb` package directly): mongoose
// bundles its own nested copy of the driver, and mixing the top-level
// `mongodb` package's types with a mongoose Connection's `.db` causes a
// structural type mismatch (two nominally different `Db`/`GridFSBucket`
// classes) — verified while building this.
const { GridFSBucket, ObjectId } = mongoose.mongo;

export function getWorkoutImagesBucket(connection: Connection): InstanceType<typeof GridFSBucket> {
  const db = connection.db;
  if (!db) throw new Error('mongoose connection has no db handle yet');
  return new GridFSBucket(db, { bucketName: WORKOUT_IMAGES_BUCKET });
}

export async function uploadWorkoutImage(
  bucket: InstanceType<typeof GridFSBucket>,
  buffer: Buffer,
  filename: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename);
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(uploadStream.id.toString()));
    uploadStream.end(buffer);
  });
}

// Unlike deleteWorkoutImages, this does NOT soft-swallow a missing file: it is
// only ever called while a workout is still being parsed (before any terminal
// status), and research.md #11 guarantees images survive until then — including
// across every retry. A ref that doesn't resolve here is a real fault, so it
// rejects and the parse fails into the T032 retry/DLQ path rather than silently
// feeding the model fewer images than the user submitted.
export async function downloadWorkoutImage(
  bucket: InstanceType<typeof GridFSBucket>,
  imageRef: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let downloadStream;
    try {
      // `new ObjectId(ref)` throws synchronously on a malformed hex string.
      downloadStream = bucket.openDownloadStream(new ObjectId(imageRef));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const chunks: Buffer[] = [];
    downloadStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    downloadStream.on('error', reject);
    downloadStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Best-effort: called once a workout reaches a terminal status (parsed /
// needs_review / failed-via-DLQ), never mid-retry. A ref already deleted
// (e.g. a redelivered duplicate past withEventIdempotency) is not an error.
export async function deleteWorkoutImages(
  bucket: InstanceType<typeof GridFSBucket>,
  imageRefs: string[],
): Promise<void> {
  await Promise.all(
    imageRefs.map(async (ref) => {
      try {
        await bucket.delete(new ObjectId(ref));
      } catch (err) {
        if (err instanceof Error && /file not found/i.test(err.message)) return;
        throw err;
      }
    }),
  );
}
