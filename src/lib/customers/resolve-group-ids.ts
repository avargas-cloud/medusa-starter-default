/**
 * Resolves a customer-group id BY NAME (case-insensitive exact match),
 * cached per process. Ids are never hardcoded in callers — the DB row is
 * the truth, this just avoids re-querying it on every hook/subscriber call.
 *
 * Fails LOUD (throws) when the group is missing: a silent miss here would
 * mean wholesale pricing/reconciliation quietly falling back to retail
 * behaviour, which is worse than a crash.
 */
import { ContainerRegistrationKeys } from "@medusajs/utils";

interface QueryGraphLike {
  graph(input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
  }): Promise<{ data: Array<{ id: string; name: string | null }> }>;
}

interface ContainerLike {
  resolve(key: string): unknown;
}

const groupIdCache = new Map<string, string>();

function cacheKey(name: string): string {
  return name.toLowerCase();
}

/** Test-only: clear the process cache between unit tests. */
export function __clearGroupIdCache(): void {
  groupIdCache.clear();
}

/**
 * Resolves the id of the customer group whose name matches `name`
 * case-insensitively and exactly (no substring match). Throws if not found —
 * callers should never proceed as if the group silently doesn't matter.
 */
export async function resolveGroupIdByName(
  container: ContainerLike,
  name: string
): Promise<string> {
  const key = cacheKey(name);
  const cached = groupIdCache.get(key);
  if (cached) return cached;

  const query = container.resolve(
    ContainerRegistrationKeys.QUERY
  ) as QueryGraphLike;
  const { data } = await query.graph({
    entity: "customer_group",
    fields: ["id", "name"],
  });

  const match = data.find(
    (g) => (g.name ?? "").toLowerCase() === name.toLowerCase()
  );
  if (!match) {
    throw new Error(
      `[resolveGroupIdByName] Customer group named "${name}" not found — fail closed, never silently skip`
    );
  }

  groupIdCache.set(key, match.id);
  return match.id;
}
