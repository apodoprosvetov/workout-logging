// Mirrors contracts/api.md's GET /analytics/weekly-volume response shape.
// apps/web only knows the HTTP contract (plan.md).
export interface WeeklyVolume {
  muscle_group: string;
  volume: number;
}

export interface WeeklyVolumeResponse {
  week: string;
  volumes: WeeklyVolume[]; // API returns them sorted by volume desc
}
