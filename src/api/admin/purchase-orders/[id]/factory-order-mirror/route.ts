/**
 * GET  /admin/purchase-orders/:id/factory-order-mirror?manufacturer=<query>
 *   → mirror state: manufacturer lines on the PO, linked FO, diff, next action.
 *
 * POST /admin/purchase-orders/:id/factory-order-mirror  { manufacturer }
 *   → no linked FO: creates a draft FO mirroring the manufacturer's PO lines.
 *   → linked FO draft/submitted and diverged: syncs FO ← PO (PO is the truth).
 *   → linked FO partially_received/received and diverged: 409 — the operator
 *     must fix/delete the Factory Receive first; sync never touches stock.
 *
 * Neither verb moves inventory — only the FO receive flow does, and it is
 * out of scope here on purpose.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { FACTORY_ORDER_STOCK_LOCATION_ID } from "../../../../../modules/factory-orders/constants";
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";
import { getActorUserId, UnauthenticatedError } from "../../../factory-orders/_lib/auth";
import { getFactoryOrdersService } from "../../../factory-orders/_lib/service-resolver";
import {
  computeMirrorDiff,
  findLinkedFo,
  isDiffEmpty,
  type KnexLike,
  loadFoLines,
  loadManufacturerPoLines,
  loadPoHeader,
  type MirrorDiff,
  type PoMirrorLine,
  RECEIPT_BLOCKED_FO_STATUSES,
  resolveManufacturer,
  SYNCABLE_FO_STATUSES,
} from "../../../factory-orders/_lib/po-mirror";

const manufacturerSchema = z.string().trim().min(2).max(100);
const postBodySchema = z.object({ manufacturer: manufacturerSchema });

function getKnex(req: AuthenticatedMedusaRequest): KnexLike {
  return (req.scope as unknown as { resolve: (k: string) => KnexLike }).resolve(
    "__pg_connection__"
  );
}

function uniqueItemCount(lines: PoMirrorLine[]): number {
  return new Set(lines.map((l) => l.product_variant_id)).size;
}

function resolveAction(
  foStatus: string | null,
  hasLines: boolean,
  inSync: boolean
): "create" | "sync" | "fix_receive" | "none" {
  if (!foStatus) return hasLines ? "create" : "none";
  if (inSync) return "none";
  if ((SYNCABLE_FO_STATUSES as readonly string[]).includes(foStatus)) return "sync";
  if ((RECEIPT_BLOCKED_FO_STATUSES as readonly string[]).includes(foStatus)) {
    return "fix_receive";
  }
  return "none";
}

interface MirrorStateBody {
  manufacturer: { id: string; qb_list_id: string; name: string; short_name: string };
  po: { id: string; number: string | null; status: string };
  line_count: number;
  unique_item_count: number;
  linked_factory_order: { id: string; number: string | null; status: string } | null;
  in_sync: boolean;
  diff: MirrorDiff | null;
  action: "create" | "sync" | "fix_receive" | "none";
}

async function buildMirrorState(
  req: AuthenticatedMedusaRequest,
  poId: string,
  manufacturerQuery: string
): Promise<
  | { ok: true; state: MirrorStateBody; poLines: PoMirrorLine[] }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const knex = getKnex(req);

  const po = await loadPoHeader(knex, poId);
  if (!po) {
    return { ok: false, status: 404, body: { error: "Purchase order not found", code: "po_not_found" } };
  }

  const resolution = await resolveManufacturer(knex, manufacturerQuery);
  if (!resolution.ok) {
    return {
      ok: false,
      status: 422,
      body: {
        error:
          resolution.code === "manufacturer_not_found"
            ? `No vendor matches "${manufacturerQuery}"`
            : `More than one vendor matches "${manufacturerQuery}"`,
        code: resolution.code,
        matches: resolution.matches,
      },
    };
  }
  const manufacturer = resolution.vendor;

  const service = getFactoryOrdersService(req);
  const poLines = await loadManufacturerPoLines(knex, poId, manufacturer.qb_list_id);
  const linkedFo = await findLinkedFo(service, poId);

  let diff: MirrorDiff | null = null;
  let inSync = false;
  if (linkedFo) {
    const foLines = await loadFoLines(service, linkedFo.id);
    diff = computeMirrorDiff(poLines, foLines);
    inSync = isDiffEmpty(diff);
  }

  return {
    ok: true,
    poLines,
    state: {
      manufacturer: {
        id: manufacturer.id,
        qb_list_id: manufacturer.qb_list_id,
        name: manufacturer.display_name,
        short_name: manufacturer.short_name,
      },
      po: { id: po.id, number: po.number, status: po.status },
      line_count: poLines.length,
      unique_item_count: uniqueItemCount(poLines),
      linked_factory_order: linkedFo,
      in_sync: linkedFo ? inSync : false,
      diff,
      action: resolveAction(linkedFo?.status ?? null, poLines.length > 0, inSync),
    },
  };
}

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const poId = req.params.id;
  if (!poId) {
    return res.status(400).json({ error: "purchase order id is required", code: "po_id_required" });
  }
  const parsed = manufacturerSchema.safeParse(req.query.manufacturer);
  if (!parsed.success) {
    return res.status(400).json({ error: "manufacturer query param is required", code: "manufacturer_required" });
  }

  const result = await buildMirrorState(req, poId, parsed.data);
  if (!result.ok) return res.status(result.status).json(result.body);
  return res.json(result.state);
}

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const poId = req.params.id;
  if (!poId) {
    return res.status(400).json({ error: "purchase order id is required", code: "po_id_required" });
  }
  const parsed = postBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "manufacturer is required", code: "manufacturer_required" });
  }

  // ── Supervisor PIN ────────────────────────────────────────────────────────
  // Este POST crea o reescribe un Factory Order (documento de compra). Como
  // todo cajero es un usuario admin, sin este gate cualquier token válido lo
  // ejecuta con un POST directo — el modal de la pantalla sólo recolecta la
  // credencial. Va DESPUÉS de la validación de forma a propósito: un body
  // malformado no debe gastar un intento del contador de PIN.
  const pinGuard = await guardSupervisorPin({
    scope: req.scope as unknown as { resolve: (k: string) => unknown },
    db: getKnex(req) as unknown as PinConn,
    pin: extractSupervisorPin(req),
    actorId: resolveActorId(req),
  });
  if (!pinGuard.ok) {
    const { status, body } = pinGuardResponse(pinGuard);
    return res.status(status).json(body);
  }

  const result = await buildMirrorState(req, poId, parsed.data.manufacturer);
  if (!result.ok) return res.status(result.status).json(result.body);
  const { state, poLines } = result;
  const service = getFactoryOrdersService(req);
  const knex = getKnex(req);

  if (state.action === "none" && !state.linked_factory_order) {
    return res.status(422).json({
      error: `This PO has no ${state.manufacturer.short_name} lines`,
      code: "no_manufacturer_lines",
    });
  }

  if (state.action === "none") {
    return res.json({ action: "noop", state });
  }

  if (state.action === "fix_receive") {
    return res.status(409).json({
      error:
        `${state.linked_factory_order?.number ?? "The linked factory order"} already has a Factory Receive applied. ` +
        `Delete or edit that receive first, then sync again.`,
      code: "fo_receipt_blocks_sync",
      state,
    });
  }

  if (state.action === "create") {
    const po = await loadPoHeader(knex, poId);
    if (!po) {
      return res.status(404).json({ error: "Purchase order not found", code: "po_not_found" });
    }
    const draftSeq = await service.getNextDraftSequence();
    const number = `FOD-${draftSeq}`;
    const subtotal = poLines.reduce((s, l) => s + l.qty * l.unit_cost_cents, 0);

    const [fo] = await service.createFactoryOrders([
      {
        status: "draft",
        number,
        draft_number: number,
        seq: null,
        vendor_id: po.vendor_id,
        vendor_name_snapshot: po.vendor_name_snapshot,
        vendor_list_id_snapshot: po.vendor_qb_list_id_snapshot,
        stock_location_id: FACTORY_ORDER_STOCK_LOCATION_ID,
        ordered_at: po.ordered_at ? new Date(po.ordered_at) : new Date(),
        expected_at: po.expected_at ? new Date(po.expected_at) : null,
        memo: `${state.manufacturer.short_name} items from ${po.number ?? po.id}`,
        shipping_method: po.shipping_method,
        payment_terms: po.payment_terms,
        linked_purchase_order_id: po.id,
        metadata: {
          manufacturer_vendor_id: state.manufacturer.id,
          manufacturer_vendor_name: state.manufacturer.name,
          manufacturer_vendor_short_name: state.manufacturer.short_name,
          manufacturer_vendor_qb_list_id: state.manufacturer.qb_list_id,
        },
        subtotal_cents: subtotal,
        tax_cents: 0,
        shipping_cents: 0,
        other_fees_cents: 0,
        total_cents: subtotal,
        total_lines: poLines.length,
        total_units_ordered: poLines.reduce((s, l) => s + l.qty, 0),
        created_by_user_id: userId,
      },
    ]);
    if (!fo) {
      return res.status(500).json({ error: "Failed to create factory order", code: "create_failed" });
    }

    await service.createFactoryOrderLines(
      poLines.map((l, i) => ({
        factory_order_id: fo.id,
        purchase_order_line_id: l.po_line_id,
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku,
        description_snapshot: l.description,
        qty_ordered: l.qty,
        qty_received: 0,
        qty_cancelled: 0,
        unit_cost_cents: l.unit_cost_cents,
        tax_cents: 0,
        total_cents: l.qty * l.unit_cost_cents,
        status: "open",
        line_order: l.line_order ?? i,
        notes: null,
      }))
    );

    return res.status(201).json({ action: "created", factory_order: fo, state });
  }

  // action === "sync" — FO is draft/submitted: every line has qty_received 0,
  // so updating/removing lines cannot orphan received stock.
  const fo = state.linked_factory_order as NonNullable<typeof state.linked_factory_order>;
  const diff = state.diff as MirrorDiff;

  const receivedTouched = [...diff.removed, ...diff.extra].filter((l) => l.qty_received > 0);
  if (receivedTouched.length > 0) {
    return res.status(409).json({
      error: "A line pending removal has received units — fix the Factory Receive first.",
      code: "fo_receipt_blocks_sync",
      state,
    });
  }

  const poBySku = new Map(poLines.map((l) => [l.po_line_id, l]));
  const foLines = await loadFoLines(service, fo.id);
  const updates: Array<Record<string, unknown>> = [];
  for (const fl of foLines) {
    if (!fl.purchase_order_line_id) continue;
    const pl = poBySku.get(fl.purchase_order_line_id);
    if (!pl) continue;
    if (
      fl.qty_ordered !== pl.qty ||
      fl.unit_cost_cents !== pl.unit_cost_cents ||
      fl.sku_snapshot !== pl.sku ||
      fl.description_snapshot !== pl.description ||
      fl.line_order !== pl.line_order
    ) {
      updates.push({
        id: fl.id,
        qty_ordered: pl.qty,
        unit_cost_cents: pl.unit_cost_cents,
        sku_snapshot: pl.sku,
        description_snapshot: pl.description,
        line_order: pl.line_order,
        total_cents: pl.qty * pl.unit_cost_cents + fl.tax_cents,
      });
    }
  }
  if (updates.length > 0) {
    await service.updateFactoryOrderLines(updates as never);
  }

  const toDelete = [...diff.removed, ...diff.extra].map((l) => l.id);
  if (toDelete.length > 0) {
    await service.deleteFactoryOrderLines(toDelete);
  }

  if (diff.missing.length > 0) {
    await service.createFactoryOrderLines(
      diff.missing.map((l, i) => ({
        factory_order_id: fo.id,
        purchase_order_line_id: l.po_line_id,
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku,
        description_snapshot: l.description,
        qty_ordered: l.qty,
        qty_received: 0,
        qty_cancelled: 0,
        unit_cost_cents: l.unit_cost_cents,
        tax_cents: 0,
        total_cents: l.qty * l.unit_cost_cents,
        status: "open",
        line_order: l.line_order ?? 1000 + i,
        notes: null,
      }))
    );
  }

  // Recompute header totals from the surviving line set, preserving
  // header-level shipping/other fees the FO may carry.
  const finalLines = await loadFoLines(service, fo.id);
  const foRow = (await service.retrieveFactoryOrder(fo.id)) as unknown as {
    shipping_cents: number;
    other_fees_cents: number;
  };
  const subtotal = finalLines.reduce((s, l) => s + l.qty_ordered * l.unit_cost_cents, 0);
  const lineTax = finalLines.reduce((s, l) => s + l.tax_cents, 0);
  const shipping = Number(foRow.shipping_cents ?? 0);
  const otherFees = Number(foRow.other_fees_cents ?? 0);
  await service.updateFactoryOrders([
    {
      id: fo.id,
      subtotal_cents: subtotal,
      tax_cents: lineTax,
      total_cents: subtotal + lineTax + shipping + otherFees,
      total_lines: finalLines.length,
      total_units_ordered: finalLines.reduce((s, l) => s + l.qty_ordered, 0),
    },
  ] as never);

  return res.json({
    action: "synced",
    changes: {
      updated: updates.length,
      added: diff.missing.length,
      removed: toDelete.length,
    },
    factory_order: { id: fo.id, number: fo.number, status: fo.status },
    state: { ...state, in_sync: true, action: "none" as const },
  });
}
