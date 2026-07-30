/**
 * src/api/admin/china-adjustment/[id]/void/route.ts
 *
 * POST /admin/china-adjustment/:id/void — reverse a mistaken China adjustment.
 *
 * Void is TERMINAL (no un-void; to redo, create a new adjustment). It reverses
 * each line's net `delta` on LIVE stock (movement-invariant: undoes exactly what
 * the adjustment applied, surviving any sales/receives since). Reserved
 * (committed/in_transit) is never touched — the adjustment never touched it.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";
import {
  CHINA_LOCATION_ID,
  type InventoryServiceLike,
  resolveKnex,
  syncChinaAdjustmentItemsToMeili,
} from "../../route";
import {
  getActorUserId,
  UnauthenticatedError,
} from "../../../purchase-orders/_lib/auth";

interface VoidBody {
  reason?: string | null;
}

interface AdjLine {
  inventory_item_id: string;
  sku: string;
  delta: number;
}

export async function POST(
  req: AuthenticatedMedusaRequest<VoidBody>,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(401).json({ error: err.message });
    }
    throw err;
  }

  const { id } = req.params;
  const reason = req.body?.reason?.trim() || null;
  const knex = resolveKnex(req);

  // PIN de supervisor. Las reglas del repo describen este void como "PIN +
  // razón" desde el 2026-07-06, pero el PIN existía SOLO en la pantalla y se
  // comparaba en el navegador: un POST directo a esta ruta revertía el delta de
  // stock de cada línea sin encontrar ninguna puerta. La razón sí se pedía acá;
  // el PIN no.
  //
  // Incondicional: revertir un ajuste de inventario mueve stock real y es
  // terminal.
  {
    const guard = await guardSupervisorPin({
      scope: req.scope as unknown as { resolve: (k: string) => unknown },
      db: knex as unknown as PinConn,
      pin: extractSupervisorPin(req),
      actorId: resolveActorId(req),
    });
    if (!guard.ok) {
      const { status, body } = pinGuardResponse(guard);
      return res.status(status).json(body);
    }
  }

  // Must exist (distinguish 404 from 409-already-voided).
  const docRes = await knex.raw(
    `SELECT id, voided_at FROM china_adjustment WHERE id = ?`,
    [id]
  );
  const doc = (docRes.rows as Array<{ voided_at: string | null }>)[0];
  if (!doc) {
    return res.status(404).json({ error: "Adjustment not found." });
  }
  if (doc.voided_at) {
    return res.status(409).json({
      error: "This adjustment is already voided.",
      code: "ALREADY_VOIDED",
    });
  }

  // Atomic claim — only one request can flip voided_at from NULL. Prevents a
  // concurrent double-void (and therefore a double reversal). If we lose the
  // race, rowCount is 0 → someone else already voided it.
  const claim = (await knex.raw(
    `UPDATE china_adjustment
        SET voided_at = now(), voided_by_user_id = ?, void_reason = ?
      WHERE id = ? AND voided_at IS NULL`,
    [userId, reason, id]
  )) as unknown as { rowCount?: number };
  if ((claim.rowCount ?? 0) === 0) {
    return res.status(409).json({
      error: "This adjustment is already voided.",
      code: "ALREADY_VOIDED",
    });
  }

  const { rows: lineRows } = await knex.raw(
    `SELECT inventory_item_id, sku, delta
       FROM china_adjustment_line WHERE china_adjustment_id = ?`,
    [id]
  );
  const lines = lineRows as AdjLine[];

  const inventoryService = req.scope.resolve(
    Modules.INVENTORY
  ) as unknown as InventoryServiceLike;

  try {
    for (const line of lines) {
      const delta = Number(line.delta ?? 0);
      if (delta !== 0) {
        // Reverse the adjustment's net movement on live stock.
        await inventoryService.adjustInventory(
          line.inventory_item_id,
          CHINA_LOCATION_ID,
          -delta
        );
      }
    }
  } catch (err) {
    // A reversal failed — un-claim so the adjustment stays ACTIVE (never a
    // half-voided doc with partially reversed stock). The operator can retry.
    await knex.raw(
      `UPDATE china_adjustment
          SET voided_at = NULL, voided_by_user_id = NULL, void_reason = NULL
        WHERE id = ?`,
      [id]
    );
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      error: `Void failed while reversing stock: ${message}. No changes were applied.`,
    });
  }

  // Best-effort search resync (never un-voids stock on failure).
  const itemIds = lines.map((l) => l.inventory_item_id);
  let meili: unknown = null;
  try {
    meili = await syncChinaAdjustmentItemsToMeili(req, itemIds);
  } catch {
    /* non-fatal */
  }

  return res.json({
    adjustment: { id, voided_at: new Date().toISOString(), voided_by_user_id: userId, void_reason: reason },
    reversed_lines: lines.length,
    meili,
  });
}
