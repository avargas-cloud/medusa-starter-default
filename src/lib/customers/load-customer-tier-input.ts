/**
 * Loads the LIVE tier input for a customer — metadata + group memberships —
 * with ONE raw SQL query, instead of `query.graph({ ..., fields:
 * ["groups.*", ...] })`.
 *
 * Why not `query.graph`: it returns customer_group_customer rows regardless
 * of `deleted_at` — a customer whose Wholesale membership was removed via
 * `removeCustomerFromGroup` (a SOFT delete) still shows up under
 * `customer.groups`. Every caller that resolves a tier from a customer id
 * must go through this loader instead, or a removed-from-Wholesale customer
 * keeps pricing/reconciling as wholesale forever.
 */
import { ContainerRegistrationKeys } from "@medusajs/utils";

export interface CustomerTierRow {
  metadata: Record<string, unknown> | null;
  groups: Array<{ id: string; name: string }>;
}

interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[] }>;
}

interface ContainerLike {
  resolve(key: string): unknown;
}

const QUERY = `
SELECT
  c.metadata,
  coalesce(
    json_agg(json_build_object('id', cg.id, 'name', cg.name))
      FILTER (WHERE cg.id IS NOT NULL),
    '[]'
  ) AS groups
FROM customer c
LEFT JOIN customer_group_customer cgc
  ON cgc.customer_id = c.id AND cgc.deleted_at IS NULL
LEFT JOIN customer_group cg
  ON cg.id = cgc.customer_group_id AND cg.deleted_at IS NULL
WHERE c.id = ? AND c.deleted_at IS NULL
GROUP BY c.id, c.metadata
`;

/**
 * Returns null when the customer does not exist (or is soft-deleted).
 * `metadata` is null when the DB value isn't a JSON object (legacy scalar
 * metadata) — callers treat that exactly like "no metadata".
 */
export async function loadCustomerTierInput(
  container: ContainerLike,
  customerId: string
): Promise<CustomerTierRow | null> {
  const knex = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as KnexLike;

  const { rows } = await knex.raw(QUERY, [customerId]);
  const row = rows[0];
  if (!row) return null;

  const rawMetadata = row.metadata;
  const metadata =
    rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : null;

  const rawGroups = Array.isArray(row.groups) ? row.groups : [];
  const groups = rawGroups
    .filter((g: unknown): g is { id: string; name: string } =>
      Boolean(g && typeof g === "object" && (g as any).id)
    )
    .map((g: { id: string; name: string | null }) => ({
      id: g.id,
      name: g.name ?? "",
    }));

  return { metadata, groups };
}
