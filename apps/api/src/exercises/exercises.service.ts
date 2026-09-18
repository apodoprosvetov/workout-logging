import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { ExerciseCatalogDocument } from '@workout-logging/shared';

export interface ExerciseCatalogEntry {
  slug: string;
  name: string;
  aliases: string[];
  muscle_groups: string[];
  equipment: string | null;
}

@Injectable()
export class ExercisesService {
  private readonly logger = new Logger(ExercisesService.name);

  constructor(@InjectConnection() private readonly mongoConnection: Connection) {}

  // The whole catalog in one response: it is a seeded reference list of a few
  // dozen entries, and a client that holds all of it matches names locally
  // instead of asking per keystroke.
  async list(): Promise<ExerciseCatalogEntry[]> {
    const catalog = this.mongoConnection.model<ExerciseCatalogDocument>('ExerciseCatalog');

    let entries: ExerciseCatalogDocument[];
    try {
      entries = await catalog.find({}).sort({ name: 1 }).lean<ExerciseCatalogDocument[]>();
    } catch (err) {
      this.logger.error(
        'exercise catalog read failed',
        err instanceof Error ? err.stack : undefined,
      );
      // 503, never an empty 200: a client reading "the catalog knows nothing"
      // would stop suggesting names and call every name the user types unknown.
      throw new ServiceUnavailableException('Could not read the exercise catalog.');
    }

    return entries.map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      aliases: entry.aliases,
      muscle_groups: entry.muscle_groups,
      equipment: entry.equipment ?? null,
    }));
  }
}
