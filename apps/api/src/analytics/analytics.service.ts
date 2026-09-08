import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { InjectDataSource } from '@nestjs/typeorm';
import { Connection } from 'mongoose';
import { DataSource } from 'typeorm';

import {
  computeWeeklyVolume,
  isoWeekKey,
  isoWeekToDate,
  weeklyVolumeRedisKey,
} from '@workout-logging/shared';

import { REDIS_CLIENT } from '../redis/redis.module';

import type Redis from 'ioredis';

export interface WeeklyVolumeResponse {
  week: string;
  volumes: Array<{ muscle_group: string; volume: number }>;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectConnection() private readonly mongoConnection: Connection,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // FR-016/FR-017: weekly volume per muscle group, scoped to the caller.
  // Reads the analytics worker's Redis hash (T047); on a miss, computes the
  // same aggregate straight from Postgres with the shared computeWeeklyVolume.
  async weeklyVolume(userId: string, week?: string): Promise<WeeklyVolumeResponse> {
    const isoWeek = week ?? isoWeekKey(new Date());

    const cached = await this.redis.hgetall(weeklyVolumeRedisKey(userId, isoWeek));
    const volume: Record<string, number> =
      Object.keys(cached).length > 0
        ? Object.fromEntries(Object.entries(cached).map(([group, value]) => [group, Number(value)]))
        : await computeWeeklyVolume(
            this.dataSource,
            this.mongoConnection,
            userId,
            isoWeekToDate(isoWeek),
          );

    return {
      week: isoWeek,
      volumes: Object.entries(volume)
        .map(([muscle_group, v]) => ({ muscle_group, volume: v }))
        .sort((a, b) => b.volume - a.volume),
    };
  }
}
