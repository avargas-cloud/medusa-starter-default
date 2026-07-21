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
