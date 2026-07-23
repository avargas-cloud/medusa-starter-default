import type { MedusaContainer } from "@medusajs/framework/types";

/**
 * Server-side hard guard for order-mutation routes: an ARCHIVED order is a
 * deliberately closed POS order (toggle-close on a partially-invoiced order)
 * — any edit must go through an explicit Reopen first. The POS UI already
 * renders these orders read-only via isClosed, but direct API calls
 * (scripts, stale tabs, races) bypassed that; this is the backstop.
 *
 * Archived-only on purpose: completed/canceled keep their pre-existing
 * behavior (their own flows guard them), and legacy pending+pos_closed rows
 * no longer exist after the 2026-07-23 backfill.
 *
 * Returns null when editable, or the blocking message (respond 409).
 */
export async function assertOrderEditable(
  scope: MedusaContainer,
  orderId: string
): Promise<string | null> {
  try {
    const pg = scope.resolve("__pg_connection__") as any;
    const { rows } = await pg.raw(
      `SELECT status FROM "order" WHERE id = ? AND deleted_at IS NULL`,
      [orderId]
    );
    const status = String(rows?.[0]?.status ?? "");
    if (status === "archived") {
      return "Order is archived (closed) — reopen it before editing";
    }
    return null;
  } catch {
    // Fail-open: this guard is defense-in-depth, never the primary gate —
    // a transient query error must not brick order editing.
    return null;
  }
}
