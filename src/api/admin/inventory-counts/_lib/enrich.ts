/**
 * src/api/admin/inventory-counts/_lib/enrich.ts
 *
 * Batch-decorates inventory_count rows with friendly references:
 *   - stock_location: { id, name }
 *   - created_by_user / reviewed_by_user: { id, first_name, last_name, email }
 *
 * Called from list + detail endpoints. Single-pass batch fetch (no N+1).
 */

import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

interface RawCount {
  stock_location_id: string;
  created_by_user_id: string;
  reviewed_by_user_id?: string | null;
}

export interface EnrichedRefs {
  stock_location: { id: string; name: string } | null;
  created_by_user: UserRef | null;
  reviewed_by_user: UserRef | null;
}

interface UserRef {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
}

interface UserModuleLike {
  listUsers: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<
    Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string;
    }>
  >;
}

interface StockLocationModuleLike {
  listStockLocations: (
    filters: Record<string, unknown>,
    options?: { take?: number }
  ) => Promise<Array<{ id: string; name: string }>>;
}

export async function buildEnrichmentMaps(
  req: AuthenticatedMedusaRequest,
  rows: RawCount[]
): Promise<{
  locations: Map<string, { id: string; name: string }>;
  users: Map<string, UserRef>;
}> {
  const locationIds = Array.from(
    new Set(rows.map((r) => r.stock_location_id).filter(Boolean))
  );
  const userIds = Array.from(
    new Set(
      rows
        .flatMap((r) => [r.created_by_user_id, r.reviewed_by_user_id ?? null])
        .filter((id): id is string => Boolean(id))
    )
  );

  const stockLocationModule = req.scope.resolve(
    Modules.STOCK_LOCATION
  ) as unknown as StockLocationModuleLike;
  const userModule = req.scope.resolve("user") as unknown as UserModuleLike;

  const [locs, users] = await Promise.all([
    locationIds.length
      ? stockLocationModule.listStockLocations(
          { id: locationIds },
          { take: locationIds.length }
        )
      : Promise.resolve([]),
    userIds.length
      ? userModule.listUsers({ id: userIds }, { take: userIds.length })
      : Promise.resolve([]),
  ]);

  const locationsMap = new Map<string, { id: string; name: string }>();
  for (const l of locs) locationsMap.set(l.id, { id: l.id, name: l.name });

  const usersMap = new Map<string, UserRef>();
  for (const u of users) {
    usersMap.set(u.id, {
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      email: u.email,
    });
  }

  return { locations: locationsMap, users: usersMap };
}

/**
 * Batch-resolves the QB sales description per product variant (lives in
 * product_variant.metadata.sales_description — same source the Meili
 * inventory doc builder reads). Display-only enrichment for count lines;
 * the stored product_title snapshot stays canonical.
 */
export async function buildSalesDescriptionMap(
  req: AuthenticatedMedusaRequest,
  variantIds: Array<string | null | undefined>
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const ids = Array.from(
    new Set(variantIds.filter((id): id is string => Boolean(id)))
  );
  if (ids.length === 0) return map;

  const pg = req.scope.resolve("__pg_connection__") as {
    raw: (
      sql: string,
      bindings?: unknown[]
    ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  };
  const result = await pg.raw(
    `SELECT id,
            NULLIF(TRIM(metadata->>'sales_description'), '') AS sales_description
       FROM product_variant
      WHERE id = ANY(?)`,
    [ids]
  );
  for (const row of result.rows) {
    map.set(
      String(row.id),
      row.sales_description ? String(row.sales_description) : null
    );
  }
  return map;
}

export function decorateCount<T extends RawCount>(
  count: T,
  maps: {
    locations: Map<string, { id: string; name: string }>;
    users: Map<string, UserRef>;
  }
): T & EnrichedRefs {
  return {
    ...count,
    stock_location: maps.locations.get(count.stock_location_id) ?? null,
    created_by_user: maps.users.get(count.created_by_user_id) ?? null,
    reviewed_by_user: count.reviewed_by_user_id
      ? (maps.users.get(count.reviewed_by_user_id) ?? null)
      : null,
  };
}
