import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  Exercise,
  ProcessedEvent,
  RefreshToken,
  TelegramLinkCode,
  User,
  Workout,
  WorkoutExercise,
  WorkoutSet,
} from '../entities';

// CLI convenience only — no-op once a real process (apps/api, apps/worker) has already loaded its own env.
if (!process.env.DATABASE_URL) {
  loadEnv({ path: path.resolve(__dirname, '../../../../.env') });
}

export const typeOrmDataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: process.env.DATABASE_URL,
  namingStrategy: new SnakeNamingStrategy(),
  entities: [
    User,
    RefreshToken,
    TelegramLinkCode,
    Workout,
    WorkoutExercise,
    Exercise,
    WorkoutSet,
    ProcessedEvent,
  ],
  migrations: [path.join(__dirname, 'migrations', '*.{ts,js}')],
  synchronize: false,
};

// For apps/api's TypeOrmModule.forRootAsync() and apps/worker's standalone DataSource.initialize().
export function createTypeOrmDataSource(): DataSource {
  return new DataSource(typeOrmDataSourceOptions);
}

// Default export: what the TypeORM CLI expects via `-d src/db/typeorm.ts`.
export default createTypeOrmDataSource();
