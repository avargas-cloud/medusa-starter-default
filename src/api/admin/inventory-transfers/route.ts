/**
 * src/api/admin/inventory-transfers/route.ts
 *
 * GET  /admin/inventory-transfers  — paginated list with optional status filter
 * POST /admin/inventory-transfers  — create a draft InventoryTransfer + lines
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { generateEntityId } from "@medusajs/utils";
import { getActorUserId, UnauthenticatedError } from "../purchase-orders/_lib/auth";

// ── Knex type ─────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

// ── Row interfaces ────────────────────────────────────────────────────────────

interface TransferRow {
  id: string;
  number: string | null;
  seq: number | null;
  status: string;
  origin_country: string;
  destination_location_id: string;
  vendor_id: string | null;
  vendor_name_snapshot: string | null;
  linked_purchase_order_id: string | null;
  linked_po_number: string | null;
  reference_number: string | null;
  tracking_number: string | null;
  shipper: string | null;
  notes: string | null;
  expected_arrival_at: string | null;
  total_lines: number;
  total_units: number;
  subtotal_cents: number;
  // Live-computed at list time from lines × factory cost (qb_purchase_cost);
  // used to override the stale header subtotal_cents/total_units for display.
  factory_subtotal_cents?: string | number | null;
  live_units?: number | null;
  created_by_user_id: string;
  confirmed_at: string | null;
  confirmed_by_user_id: string | null;
  shipped_at: string | null;
  shipped_by_user_id: string | null;
  received_at: string | null;
  received_by_user_id: string | null;
  voided_at: string | null;
  voided_by_user_id: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface TransferLineInput {
  product_variant_id: string;
  sku: string;
  description?: string;
  qty: number;
  unit_cost_cents?: number;
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const knex = resolveKnex(req);

  const rawStatus = (req.query as Record<string, string>).status ?? null;
  const linkedPoId = (req.query as Record<string, string>).linked_po_id ?? null;
  const limit = Math.min(
    parseInt((req.query as Record<string, string>).limit ?? "200", 10),
    500
  );
  const offset = parseInt(
    (req.query as Record<string, string>).offset ?? "0",
    10
  );

  let whereClause = `WHERE it.deleted_at IS NULL`;
  const bindings: unknown[] = [];

  if (rawStatus) {
    const statuses = rawStatus
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (statuses.length === 1) {
      whereClause += ` AND it.status = ?`;
      bindings.push(statuses[0]);
    } else if (statuses.length > 1) {
      const placeholders = statuses.map(() => "?").join(", ");
      whereClause += ` AND it.status IN (${placeholders})`;
      bindings.push(...statuses);
    }
  }

  if (linkedPoId) {
    whereClause += ` AND it.linked_purchase_order_id = ?`;
    bindings.push(linkedPoId);
  }

  const countResult = await knex.raw(
    `SELECT COUNT(*)::int AS total FROM inventory_transfer it ${whereClause}`,
    bindings
  );
  const count = (countResult.rows[0] as { total: number }).total;

  bindings.push(limit, offset);
  const dataResult = await knex.raw(
    `SELECT it.*, po.number AS linked_po_number,
            agg.factory_subtotal_cents,
            agg.live_units
     FROM inventory_transfer it
     LEFT JOIN purchase_order po ON po.id = it.linked_purchase_order_id AND po.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(itl.qty * ROUND(COALESCE(NULLIF(pv.metadata->>'purchase_cost','')::numeric, NULLIF(pv.metadata->>'qb_purchase_cost','')::numeric, 0) * 100)), 0)::bigint AS factory_subtotal_cents,
              COALESCE(SUM(itl.qty), 0)::int AS live_units
       FROM inventory_transfer_line itl
       LEFT JOIN product_variant pv ON pv.id = itl.product_variant_id
       WHERE itl.transfer_id = it.id AND itl.deleted_at IS NULL
     ) agg ON true
     ${whereClause}
     ORDER BY it.created_at DESC
     LIMIT ? OFFSET ?`,
    bindings
  );

  // Override the stale header subtotal_cents/total_units with values computed
  // live from the current lines at FACTORY cost (qb_purchase_cost).
  const transfers = (dataResult.rows as TransferRow[]).map((r) => ({
    ...r,
    subtotal_cents: Number(r.factory_subtotal_cents ?? r.subtotal_cents),
    total_units: Number(r.live_units ?? r.total_units),
  }));

  return res.json({ transfers, count, limit, offset });
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const body = req.body as {
    destination_location_id?: string;
    vendor_id?: string | null;
    vendor_name_snapshot?: string | null;
    reference_number?: string | null;
    tracking_number?: string | null;
    shipper?: string | null;
    notes?: string | null;
    expected_arrival_at?: string | null;
    lines?: TransferLineInput[];
  };

  const destinationLocationId = body.destination_location_id?.trim();
  if (!destinationLocationId) {
    return res.status(400).json({
      error: "destination_location_id is required",
      code: "missing_field",
    });
  }

  const knex = resolveKnex(req);

  // Allocate sequence number
  const seqResult = await knex.raw(
    `SELECT nextval('custom_inventory_transfer_seq') AS seq`
  );
  const seq = Number((seqResult.rows[0] as { seq: string | number }).seq);
  const number = `IT-${seq}`;

  const id = generateEntityId("", "it");
  const now = new Date().toISOString();

  const lines: TransferLineInput[] = body.lines ?? [];

  // Insert transfer header
  await knex.raw(
    `INSERT INTO inventory_transfer (
      id, number, seq, status, origin_country, destination_location_id,
      vendor_id, vendor_name_snapshot, reference_number, tracking_number, shipper, notes,
      expected_arrival_at, total_lines, total_units, subtotal_cents,
      created_by_user_id, created_at, updated_at
    ) VALUES (
      ?, ?, ?, 'draft', 'CN', ?,
      ?, ?, ?, ?, ?, ?,
      ?, 0, 0, 0,
      ?, ?, ?
    )`,
    [
      id, number, seq, destinationLocationId,
      body.vendor_id ?? null, body.vendor_name_snapshot ?? null,
      body.reference_number ?? null, body.tracking_number ?? null,
      body.shipper ?? null, body.notes ?? null,
      body.expected_arrival_at ?? null,
      userId, now, now,
    ]
  );

  // Insert lines
  if (lines.length > 0) {
    for (const line of lines) {
      const lineId = generateEntityId("", "itl");
      await knex.raw(
        `INSERT INTO inventory_transfer_line (
          id, transfer_id, product_variant_id, sku, description,
          qty, unit_cost_cents, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          lineId, id, line.product_variant_id, line.sku,
          line.description ?? "", line.qty,
          line.unit_cost_cents ?? 0, now, now,
        ]
      );
    }
  }

  // Compute and update totals
  const totalLines = lines.length;
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  const subtotalCents = lines.reduce(
    (s, l) => s + l.qty * (l.unit_cost_cents ?? 0),
    0
  );

  await knex.raw(
    `UPDATE inventory_transfer
     SET total_lines = ?, total_units = ?, subtotal_cents = ?, updated_at = ?
     WHERE id = ?`,
    [totalLines, totalUnits, subtotalCents, now, id]
  );

  // Fetch full transfer + lines to return
  const transferResult = await knex.raw(
    `SELECT * FROM inventory_transfer WHERE id = ?`,
    [id]
  );
  const linesResult = await knex.raw(
    `SELECT * FROM inventory_transfer_line WHERE transfer_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    [id]
  );

  const transfer = {
    ...(transferResult.rows[0] as TransferRow),
    lines: linesResult.rows,
  };

  return res.status(201).json({ transfer });
}
