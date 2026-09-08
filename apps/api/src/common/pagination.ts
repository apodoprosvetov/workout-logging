import { SelectQueryBuilder } from 'typeorm';

import { DEFAULT_PAGE, DEFAULT_PER_PAGE, PaginationQueryDto } from './pagination.dto';

/**
 * The envelope every list endpoint returns.
 *
 * `next_page` / `prev_page` are derivable from `total`, `page` and `per_page`,
 * and are included anyway: they turn "is there more?" into a null check on the
 * client instead of arithmetic it has to get right. Both are null at the ends.
 */
export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
  next_page: number | null;
  prev_page: number | null;
}

/**
 * Run a query builder as one page and wrap it in the standard envelope.
 *
 * The builder must already carry its filters **and a total ordering** — offset
 * pagination over a non-total `ORDER BY` silently skips and repeats rows
 * between pages, because the database is free to return tied rows in a
 * different order for each page's query. In this codebase that means every
 * ordering ends in a unique column (see WorkoutsService.list, which appends
 * `id`).
 *
 * `map` converts an entity to its wire shape; it runs only over the page, never
 * the whole table.
 */
export async function paginate<Entity extends object, Wire>(
  qb: SelectQueryBuilder<Entity>,
  query: PaginationQueryDto,
  map: (entity: Entity) => Wire,
): Promise<Paginated<Wire>> {
  const page = query.page ?? DEFAULT_PAGE;
  const perPage = query.per_page ?? DEFAULT_PER_PAGE;

  // getManyAndCount issues the page query plus a COUNT over the same filters.
  // Two round trips, and the reason `total` can be reported at all.
  const [entities, total] = await qb
    .skip((page - 1) * perPage)
    .take(perPage)
    .getManyAndCount();

  const lastPage = Math.max(1, Math.ceil(total / perPage));

  return {
    data: entities.map(map),
    total,
    page,
    per_page: perPage,
    // A page past the end has no next: asking for page 9 of 3 returns an empty
    // data array rather than an error, and must not advertise a page 10.
    next_page: page < lastPage ? page + 1 : null,
    prev_page: page > 1 ? page - 1 : null,
  };
}
