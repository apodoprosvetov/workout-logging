// The envelope every list endpoint returns, mirroring apps/api's
// src/common/pagination.ts. apps/web only knows the HTTP contract, so this is a
// hand-kept mirror rather than a shared import (packages/shared is CommonJS and
// its barrel pulls in mongoose/pg/ioredis — nothing that belongs in a browser
// bundle).
export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
  /** null on the last page. A null here is the whole "is there more?" check. */
  next_page: number | null;
  /** null on the first page. */
  prev_page: number | null;
}

export const FIRST_PAGE = 1;
