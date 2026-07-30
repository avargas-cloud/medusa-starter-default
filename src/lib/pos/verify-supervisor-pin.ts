/**
 * Server-side supervisor PIN check (defense in depth — a frontend-only gate is
 * not a gate). Fail-CLOSED: any missing store row, unset PIN, or query error
 * denies the operation rather than waving it through.
 *
 * NOTE: this variant takes a KNEX-style connection (`?` placeholders, from
 * `container.resolve("__pg_connection__")`). The pg-pool callsites use `$1`
 * placeholders — the two are NOT interchangeable, so do not "unify" them by
 * swapping the binding style.
 */

export interface PinConn {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export async function verifySupervisorPin(
  db: PinConn,
  pin: unknown
): Promise<boolean> {
  const supplied = String(pin ?? "");
  if (supplied.length === 0) return false;
  try {
    const { rows } = await db.raw(
      `SELECT metadata FROM store
        WHERE metadata->>'pos_supervisor_pin' IS NOT NULL
        ORDER BY id LIMIT 1`
    );
    const stored = (rows[0] as { metadata?: Record<string, unknown> } | undefined)
      ?.metadata?.pos_supervisor_pin;
    if (stored === undefined || stored === null) return false;
    const expected = String(stored);
    if (expected.length === 0) return false;
    return supplied === expected;
  } catch {
    return false;
  }
}

/**
 * Adaptador para los callsites que tienen un pg POOL en vez de knex.
 *
 * El docstring de arriba advierte —con razón— que los dos estilos de binding no
 * son intercambiables. Pero la query de este helper NO LLEVA PARÁMETROS, así que
 * la advertencia no aplica: lo único que hace falta es algo que ejecute un SQL
 * crudo.
 *
 * Existe porque cuatro rutas (transfer de pago, adopt/undo de bill-match, import
 * de créditos QB) habían copiado la comparación a mano justo por esa
 * incompatibilidad aparente — y al copiarla se quedaron sin el límite de
 * intentos, que es lo único que separa "hay que saber el PIN" de "hay que
 * adivinarlo".
 */
export function pgAsPinConn(pool: {
  query: (sql: string) => Promise<{ rows: unknown[] }>;
}): PinConn {
  return { raw: (sql: string) => pool.query(sql) };
}
