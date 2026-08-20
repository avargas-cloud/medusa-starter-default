/**
 * POST /admin/orders/:id/separations
 *
 * Writes per-line separated quantities. The MODAL only collects numbers — this
 * route is the authorization: every requested quantity is re-validated here
 * against fresh physical Miami inventory net of other orders' live
 * separations, never against what the screen believed.
 *
 * Body: { separations: [{ line_id, qty }] } — qty is the line's new TOTAL
 * separated amount (not a delta); 0 clears the mark. Lines not included keep
 * their stored value.
 *
 * Separation NEVER moves stock or reservations — it is an operational mark.
 * The row upserts and the derived order metadata (`separation_status` +
 * `is_separated`, the boolean mirror the Separated tab and Meili consume)
 * commit in ONE transaction; the UPDATE on "order" fires the Meili trigger.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import {
  recordPosActivity,
  type KnexRawConnection,
} from "../../../../../lib/pos/order-activity";
import { validateSeparationRequest } from "../../_lib/separation-caps";
import { deriveSeparationStatus } from "../../_lib/separation-status";
import { loadSeparationData } from "../_lib/separation-data";

interface SeparationInput {
  line_id?: unknown;
  qty?: unknown;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const orderId = req.params.id ?? "";
  if (!orderId) {
    res.status(400).json({ error: "order id is required" });
    return;
  }
  const body = (req.body ?? {}) as { separations?: SeparationInput[] };

  if (!Array.isArray(body.separations) || body.separations.length === 0) {
    res.status(400).json({ error: "separations array is required" });
    return;
  }

  const requested = new Map<string, number>();
  for (const entry of body.separations) {
    const lineId = typeof entry.line_id === "string" ? entry.line_id : "";
    const qty = typeof entry.qty === "number" ? entry.qty : Number(entry.qty);
    if (!lineId || !Number.isFinite(qty) || qty < 0) {
      res.status(400).json({
        error: "each separation needs a line_id and a qty >= 0",
      });
      return;
    }
    requested.set(lineId, qty);
  }

  const pool = getDbPool();
  const data = await loadSeparationData(pool, orderId);
  if (!data) {
    res.status(404).json({ error: "order not found" });
    return;
  }

  const knownLineIds = new Set(data.lines.map((l) => l.lineId));
  for (const lineId of requested.keys()) {
    if (!knownLineIds.has(lineId)) {
      res.status(400).json({
        error: `line ${lineId} does not belong to this order's current version`,
      });
      return;
    }
  }

  const rejections = validateSeparationRequest(
    data.lines,
    data.inventory,
    requested
  );
  if (rejections.length) {
    // Two different refusals share this response, and telling the operator the
    // wrong one sends them hunting for stock that was never the problem.
    const belowFloor = rejections.every(
      (r) => r.reason === "below_invoiced_floor"
    );
    res.status(409).json({
      error: belowFloor
        ? "separation_below_invoiced_floor"
        : "separation_exceeds_inventory",
      message: belowFloor
        ? "Invoiced units that have not left the warehouse cannot be un-separated."
        : "Some quantities exceed what is left after other orders' separations.",
      rejections,
    });
    return;
  }

  // Merge requested over stored to derive the resulting order-level status.
  const mergedLines = data.lines.map((l) => ({
    quantity: l.quantity,
    fulfilled: l.fulfilled,
    separated: requested.has(l.lineId)
      ? (requested.get(l.lineId) as number)
      : l.separated,
  }));
  const separation_status = deriveSeparationStatus(
    mergedLines,
    data.legacySeparatedFlag
  );
  const isSeparated = separation_status === "full";

  const actorId = req.auth_context?.actor_id ?? null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [lineId, qty] of requested) {
      await client.query(
        `INSERT INTO order_line_separation
                 (order_id, order_line_item_id, qty, updated_by)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (order_id, order_line_item_id)
          DO UPDATE SET qty = EXCLUDED.qty,
                        updated_by = EXCLUDED.updated_by,
                        updated_at = now()`,
        [orderId, lineId, qty, actorId]
      );
    }
    // Same transaction as the rows so status and lines can never disagree.
    // The UPDATE on "order" fires the Meili sync trigger.
    await client.query(
      `UPDATE "order"
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [
        orderId,
        JSON.stringify({
          is_separated: isSeparated,
          separation_status,
        }),
      ]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Native Activity Log footprint: WHO set aside WHAT (per-SKU from→to), so
  // the owner can track warehouse work per user. Only real changes are
  // recorded — re-saving identical values leaves no entry. Best-effort by
  // contract (recordPosActivity swallows failures): the save already
  // committed and activity must never undo it.
  const changes = [...requested]
    .map(([lineId, qty]) => {
      const l = data.lines.find((x) => x.lineId === lineId);
      if (!l || qty === l.separated) return null;
      return { sku: l.sku || "—", from: l.separated, to: qty };
    })
    .filter((c): c is { sku: string; from: number; to: number } => c !== null);
  if (changes.length) {
    const knexConn = req.scope.resolve("__pg_connection__") as KnexRawConnection;
    await recordPosActivity(knexConn, {
      orderId,
      event: "separation_saved",
      details: { changes, status: separation_status },
      userId: actorId,
    });
  }

  res.json({
    separation_status,
    is_separated: isSeparated,
    lines: mergedLines.length,
  });
}
