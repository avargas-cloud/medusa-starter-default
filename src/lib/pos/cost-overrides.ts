import type { Pool } from "pg";

/**
 * Cost-override deltas para el Price Calculator del POS.
 *
 * El problema que esta pieza resuelve: el modal guardaba `cost_overrides`
 * mandando el OBJETO COMPLETO al POST nativo del documento, y el mergeMetadata
 * de Medusa reemplaza el valor de la clave entera — dos saves in-flight se
 * pisaban (el segundo POST no llevaba la clave del primero y la borraba del
 * server). Un delta `{set, remove}` aplicado en UN solo UPDATE de JSONB es
 * atómico por row-lock: escrituras concurrentes sobre claves distintas se
 * serializan sin perderse; sobre la misma clave, last-write-wins explícito.
 */

export interface CostOverridesDelta {
  set: Record<string, number>;
  remove: string[];
}

const MAX_KEYS = 200;
const MAX_KEY_LEN = 128;

export function validateCostOverridesDelta(
  body: unknown
): { delta: CostOverridesDelta } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "body must be an object { set?, remove? }" };
  }
  const { set, remove, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    return { error: `unknown fields: ${Object.keys(rest).join(", ")}` };
  }

  const outSet: Record<string, number> = {};
  if (set !== undefined) {
    if (typeof set !== "object" || set === null || Array.isArray(set)) {
      return { error: "set must be an object of { key: cost }" };
    }
    const entries = Object.entries(set as Record<string, unknown>);
    if (entries.length > MAX_KEYS) return { error: `set exceeds ${MAX_KEYS} keys` };
    for (const [key, value] of entries) {
      if (!key || key.length > MAX_KEY_LEN) {
        return { error: `invalid override key: ${JSON.stringify(key).slice(0, 140)}` };
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return { error: `cost for ${key} must be a finite number > 0` };
      }
      // Canónico a 4 decimales — espejo de parseCostInput del POS.
      outSet[key] = Math.round(value * 10000) / 10000;
    }
  }

  const outRemove: string[] = [];
  if (remove !== undefined) {
    if (!Array.isArray(remove)) return { error: "remove must be an array of keys" };
    if (remove.length > MAX_KEYS) return { error: `remove exceeds ${MAX_KEYS} keys` };
    for (const key of remove) {
      if (typeof key !== "string" || !key || key.length > MAX_KEY_LEN) {
        return { error: `invalid remove key: ${JSON.stringify(key).slice(0, 140)}` };
      }
      outRemove.push(key);
    }
  }

  if (Object.keys(outSet).length === 0 && outRemove.length === 0) {
    return { error: "delta must set or remove at least one key" };
  }
  const overlap = outRemove.filter((k) => k in outSet);
  if (overlap.length > 0) {
    return { error: `keys in both set and remove: ${overlap.join(", ")}` };
  }
  return { delta: { set: outSet, remove: outRemove } };
}

export interface ApplyResult {
  found: boolean;
  costOverrides: Record<string, number>;
}

/**
 * Aplica el delta en UN UPDATE atómico sobre `order.metadata.cost_overrides`,
 * preservando el resto del metadata, y devuelve el objeto canónico resultante.
 * `isDraft` ancla la ruta al recurso correcto (un draft no se escribe por la
 * ruta de órdenes ni al revés — la clase de bug documentType).
 */
export async function applyCostOverridesDelta(
  pool: Pool,
  orderId: string,
  isDraft: boolean,
  delta: CostOverridesDelta
): Promise<ApplyResult> {
  const { rows } = await pool.query<{ cost_overrides: Record<string, number> | null }>(
    `UPDATE "order"
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{cost_overrides}',
              (COALESCE(metadata->'cost_overrides', '{}'::jsonb) || $2::jsonb) - $3::text[]
            ),
            updated_at = NOW()
      WHERE id = $1
        AND deleted_at IS NULL
        AND is_draft_order = $4
      RETURNING metadata->'cost_overrides' AS cost_overrides`,
    [orderId, JSON.stringify(delta.set), delta.remove, isDraft]
  );
  const row = rows[0];
  if (!row) return { found: false, costOverrides: {} };
  return { found: true, costOverrides: row.cost_overrides ?? {} };
}
