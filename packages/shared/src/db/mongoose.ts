import path from 'node:path';

import { config as loadEnv } from 'dotenv';
import mongoose, { Connection } from 'mongoose';

import { ExerciseCatalogSchema, RawUploadSchema } from '../schemas';

// CLI convenience only — no-op once a real process (apps/api, apps/worker) has already loaded its own env.
if (!process.env.MONGO_URL) {
  loadEnv({ path: path.resolve(__dirname, '../../../../.env') });
}

// For apps/api's MongooseModule.forRoot(mongoUri).
export const mongoUri = process.env.MONGO_URL as string;

// Registers the shared models on a connection and ensures their declared indexes exist.
export async function registerMongooseModels(connection: Connection): Promise<Connection> {
  connection.model('RawUpload', RawUploadSchema);
  connection.model('ExerciseCatalog', ExerciseCatalogSchema);
  await connection.syncIndexes();
  return connection;
}

// For apps/worker's standalone connection (no Nest).
export async function createMongooseConnection(): Promise<Connection> {
  const connection = mongoose.createConnection(mongoUri);
  await connection.asPromise();
  return registerMongooseModels(connection);
}
