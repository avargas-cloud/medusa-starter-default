import { generateEntityId } from "@medusajs/utils";

// Same shape as the `req.scope.resolve("__pg_connection__")` result used
// elsewhere in the repo (knex.raw, `?` placeholders — never `$n`).
export interface KnexRawConnection {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
}

export interface PosActivityInput {
  orderId: string;
  event: string; // e.g. "email_sent"
  details?: Record<string, unknown>; // e.g. { to, by, docType }
  userId?: string | null;
}

/**
 * Inserts one `order_change` row that acts as a native Activity Log entry
 * for the POS. Contract with the frontend: `internal_note` is prefixed with
 * `__pos_activity__` followed by a JSON blob — see ActivityLog.tsx.
 *
 * Best-effort: any failure is logged and swallowed. Recording activity must
 * never fail the operation that triggered it.
 */
export async function recordPosActivity(
  knexConn: KnexRawConnection,
  input: PosActivityInput
): Promise<void> {
  try {
    const id = generateEntityId("", "ordch");
    const internalNote =
      "__pos_activity__" +
      JSON.stringify({ event: input.event, ...input.details });

    await knexConn.raw(
      `INSERT INTO order_change (
         id, order_id, version, status, change_type,
         internal_note, created_by, confirmed_at, created_at, updated_at
       ) VALUES (
         ?, ?, COALESCE((SELECT version FROM "order" WHERE id = ?), 1), 'confirmed', 'pos_activity',
         ?, ?, now(), now(), now()
       )`,
      [id, input.orderId, input.orderId, internalNote, input.userId ?? null]
    );
  } catch (err: unknown) {
    console.error("[pos-activity] failed:", err);
  }
}
