import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";
import { Client } from "pg";

import { FINANCE_MODULE } from "../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../modules/invoices";
import { syncCustomerToMeili } from "../../../../lib/meilisearch/sync-customer";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../workflows/sync-inventory-item-meilisearch";

type PosDocType =
  | "estimate"
  | "order"
  | "invoice"
  | "return"
  | "payment"
  | "purchase_order"
  | "inventory_adjustment"
  | "item_receipt"
  | "customer"
  | "variant";

const VALID_TYPES: PosDocType[] = [
  "estimate",
  "order",
  "invoice",
  "return",
  "payment",
  "purchase_order",
  "inventory_adjustment",
  "item_receipt",
  "customer",
  "variant",
];

// ─── Friendly ID resolver ─────────────────────────────────────────────────────
//
// Accepts either an internal UUID (ord_01J..., pinv_01J...) or a human-friendly
// reference (E42, #42, 42, INV-0001, CM-0001, etc.) and returns the internal UUID.

const UUID_PREFIX_RE = /^(order_|pinv_|pcm_|cpay_)/;

async function resolveId(
  client: InstanceType<typeof Client>,
  type: PosDocType,
  raw: string
): Promise<string | null> {
  const id = raw.trim();

  if (UUID_PREFIX_RE.test(id)) return id; // already a UUID

  if (type === "estimate") {
    // document_number stored as e.g. "E1316" — search case-insensitively
    // Also accept plain number "1316" → auto-prefix with E
    const upper = id.toUpperCase();
    const withE = upper.startsWith("E") ? upper : `E${upper}`;
    const { rows } = await client.query(
      `SELECT id FROM "order"
             WHERE (metadata->>'document_number' = $1 OR metadata->>'document_number' = $2)
               AND status = 'draft'
             ORDER BY created_at DESC LIMIT 1`,
      [upper, withE]
    );
    return rows[0]?.id ?? null;
  }

  if (type === "order") {
    // document_number stored as e.g. "S10112" — search case-insensitively
    // Also accept plain number "10112" → auto-prefix with S
    const upper = id.toUpperCase();
    const withS = upper.startsWith("S") ? upper : `S${upper}`;
    const { rows } = await client.query(
      `SELECT id FROM "order"
             WHERE (metadata->>'document_number' = $1 OR metadata->>'document_number' = $2)
               AND status != 'draft'
             LIMIT 1`,
      [upper, withS]
    );
    return rows[0]?.id ?? null;
  }

  if (type === "invoice") {
    const { rows } = await client.query(
      `SELECT id FROM pos_invoice WHERE id = $1 OR invoice_number = $2 LIMIT 1`,
      [id, id]
    );
    return rows[0]?.id ?? null;
  }

  if (type === "return") {
    // Accept: CM-20065, cm-20065, 20065 (auto-prefix CM-), or direct internal UUID
    const upper = id.toUpperCase();
    const withCM = upper.startsWith("CM") ? upper : `CM-${upper}`;
    const { rows } = await client.query(
      `SELECT id FROM pos_credit_memo
             WHERE id = $1 OR credit_memo_number ILIKE $2 OR credit_memo_number ILIKE $3
             LIMIT 1`,
      [id, upper, withCM]
    );
    return rows[0]?.id ?? null;
  }

  if (type === "payment") {
    const num = parseInt(id, 10);
    if (!isNaN(num)) {
      const { rows } = await client.query(
        `SELECT id FROM customer_payment WHERE display_id = $1 LIMIT 1`,
        [num]
      );
      if (rows[0]?.id) return rows[0].id;
    }
    const { rows } = await client.query(
      `SELECT id FROM customer_payment WHERE reference = $1 LIMIT 1`,
      [id]
    );
    return rows[0]?.id ?? null;
  }

  if (type === "purchase_order") {
    const upper = id.toUpperCase();
    const { rows } = await client.query(
      `SELECT id FROM purchase_order WHERE number ILIKE $1 AND deleted_at IS NULL LIMIT 1`,
      [upper]
    );
    return rows[0]?.id ?? null;
  }

  if (type === "inventory_adjustment") {
    const { rows } = await client.query(
      `SELECT id FROM inventory_count WHERE number ILIKE $1 AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    return rows[0]?.id ?? null;
  }

  if (type === "item_receipt") {
    const upper = id.toUpperCase();
    const { rows } = await client.query(
      `SELECT id FROM purchase_order_receipt WHERE number ILIKE $1 AND deleted_at IS NULL LIMIT 1`,
      [upper]
    );
    return rows[0]?.id ?? null;
  }

  if (type === "customer") {
    // Customer IDs are always cust_... — accept as-is. Also accept email lookup.
    if (id.startsWith("cust_")) return id;
    const { rows } = await client.query(
      `SELECT id FROM customer WHERE email = $1 AND deleted_at IS NULL LIMIT 1`,
      [id.toLowerCase()]
    );
    return rows[0]?.id ?? null;
  }

  if (type === "variant") {
    // Variant IDs are variant_... — accept as-is. Also accept SKU lookup.
    if (id.startsWith("variant_")) return id;
    const { rows } = await client.query(
      `SELECT id FROM product_variant WHERE sku = $1 AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    return rows[0]?.id ?? null;
  }

  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractQbFields(
  meta: Record<string, unknown> | null | undefined,
  type: PosDocType
) {
  if (!meta)
    return {
      qb_txn_id: null,
      qb_ref_number: null,
      qb_sync_status: null,
      qb_edit_sequence: null,
      qb_is_sales_receipt: null,
    };

  if (type === "estimate") {
    const est = meta.qb_estimate;
    if (est && typeof est === "object" && !Array.isArray(est)) {
      return {
        qb_txn_id: (est as any).txn_id ?? null,
        qb_ref_number: (est as any).ref_number ?? null,
        qb_sync_status: (meta.qb_sync_status as string) ?? null,
        qb_edit_sequence: (est as any).edit_sequence ?? null,
        qb_is_sales_receipt: null,
      };
    }
    return {
      qb_txn_id: (meta.qb_estimate_txn_id as string) ?? null,
      qb_ref_number: (meta.qb_estimate_ref as string) ?? null,
      qb_sync_status: (meta.qb_sync_status as string) ?? null,
      qb_edit_sequence: null,
      qb_is_sales_receipt: null,
    };
  }

  if (type === "order") {
    const so = meta.qb_sales_order;
    if (so && typeof so === "object" && !Array.isArray(so)) {
      return {
        qb_txn_id: (so as any).txn_id ?? null,
        qb_ref_number: (so as any).ref_number ?? null,
        qb_sync_status: (meta.qb_sync_status as string) ?? null,
        qb_edit_sequence: (so as any).edit_sequence ?? null,
        qb_is_sales_receipt: null,
      };
    }
    return {
      qb_txn_id: (meta.qb_sales_order_txn_id as string) ?? null,
      qb_ref_number: (meta.qb_sales_order_ref as string) ?? null,
      qb_sync_status: (meta.qb_sync_status as string) ?? null,
      qb_edit_sequence: null,
      qb_is_sales_receipt: null,
    };
  }

  // invoice: flat fields in metadata
  if (type === "invoice") {
    return {
      qb_txn_id:
        (meta.qb_invoice_txn_id as string) ??
        (meta.qb_txn_id as string) ??
        null,
      qb_ref_number: (meta.qb_ref_number as string) ?? null,
      qb_sync_status: (meta.qb_sync_status as string) ?? null,
      qb_edit_sequence: (meta.qb_edit_sequence as string) ?? null,
      qb_is_sales_receipt: (meta.qb_is_sales_receipt as boolean) ?? null,
    };
  }

  // return: built from direct columns (qb_txn_id, qb_edit_sequence)
  // payment: flat fields in metadata
  if (type === "return" || type === "payment") {
    return {
      qb_txn_id: (meta.qb_txn_id as string) ?? null,
      qb_ref_number: (meta.qb_ref_number as string) ?? null,
      qb_sync_status: (meta.qb_sync_status as string) ?? null,
      qb_edit_sequence: (meta.qb_edit_sequence as string) ?? null,
      qb_is_sales_receipt: null,
    };
  }

  return {
    qb_txn_id: null,
    qb_ref_number: null,
    qb_sync_status: null,
    qb_edit_sequence: null,
    qb_is_sales_receipt: null,
  };
}

// ─── GET ─────────────────────────────────────────────────────────────────────

/**
 * GET /admin/quickbooks/metadata?type=<type>&id=<id>
 *
 * Returns current QB metadata for any POS entity type.
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const type = req.query.type as string | undefined;
  const id = req.query.id as string | undefined;

  if (!type || !VALID_TYPES.includes(type as PosDocType)) {
    res
      .status(400)
      .json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` });
    return;
  }
  if (!id?.trim()) {
    res.status(400).json({ error: "id is required" });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    // Resolve friendly ID → internal UUID
    const resolvedId = await resolveId(client, type as PosDocType, id);
    if (!resolvedId) {
      res.status(404).json({ error: `${type} "${id}" not found` });
      return;
    }
    const internalId = resolvedId;

    // ── customer / variant: simple metadata-only lookup (no pipeline) ─────
    if (type === "customer") {
      const { rows } = await client.query<{
        id: string;
        email: string | null;
        company_name: string | null;
        first_name: string | null;
        last_name: string | null;
        qb_list_id: string | null;
        qb_edit_sequence: string | null;
      }>(
        `SELECT id, email, company_name, first_name, last_name,
                metadata->>'qb_list_id' AS qb_list_id,
                metadata->>'qb_edit_sequence' AS qb_edit_sequence
           FROM customer WHERE id = $1 LIMIT 1`,
        [internalId]
      );
      const c = rows[0];
      if (!c) {
        res.status(404).json({ error: `Customer ${internalId} not found` });
        return;
      }
      res.json({
        type,
        id: internalId,
        qb_txn_id: c.qb_list_id ?? null,
        qb_ref_number: null,
        qb_sync_status: null,
        qb_edit_sequence: c.qb_edit_sequence ?? null,
        qb_is_sales_receipt: null,
        display_info: {
          email: c.email,
          company_name: c.company_name,
          first_name: c.first_name,
          last_name: c.last_name,
        },
        pipeline_rows: [],
      });
      return;
    }

    if (type === "variant") {
      const { rows } = await client.query<{
        id: string;
        sku: string | null;
        title: string | null;
        product_title: string | null;
        quickbooks_id: string | null;
      }>(
        `SELECT pv.id, pv.sku, pv.title, p.title AS product_title,
                pv.metadata->>'quickbooks_id' AS quickbooks_id
           FROM product_variant pv
           JOIN product p ON p.id = pv.product_id
          WHERE pv.id = $1 LIMIT 1`,
        [internalId]
      );
      const v = rows[0];
      if (!v) {
        res.status(404).json({ error: `Variant ${internalId} not found` });
        return;
      }
      res.json({
        type,
        id: internalId,
        qb_txn_id: v.quickbooks_id ?? null,
        qb_ref_number: null,
        qb_sync_status: null,
        qb_edit_sequence: null,
        qb_is_sales_receipt: null,
        display_info: {
          sku: v.sku,
          title: v.title,
          product_title: v.product_title,
        },
        pipeline_rows: [],
      });
      return;
    }

    let entity_metadata: Record<string, unknown> | null = null;
    let display_info: Record<string, unknown> = {};

    // ── estimate / order ─────────────────────────────────────────────────
    if (type === "estimate" || type === "order") {
      const orderModule = req.scope.resolve(Modules.ORDER);
      const order = await orderModule
        .retrieveOrder(internalId)
        .catch(() => null);
      if (!order) {
        res.status(404).json({ error: `Order ${internalId} not found` });
        return;
      }
      entity_metadata = (order as any).metadata ?? {};
      display_info = {
        display_id: (order as any).display_id ?? null,
        status: (order as any).status ?? null,
        email: (order as any).email ?? null,
      };
    }

    // ── invoice (pos_invoice) ─────────────────────────────────────────────
    if (type === "invoice") {
      const invoiceService = req.scope.resolve(INVOICE_MODULE);
      const [invoice] = await invoiceService
        .listPosInvoices({ id: [internalId] })
        .catch(() => []);
      if (!invoice) {
        res.status(404).json({ error: `Invoice ${internalId} not found` });
        return;
      }
      entity_metadata = (invoice as any).metadata ?? {};
      display_info = {
        invoice_number: (invoice as any).invoice_number ?? null,
        order_id: (invoice as any).order_id ?? null,
        status: (invoice as any).status ?? null,
      };
    }

    // ── return (pos_credit_memo) ─────────────────────────────────────────
    // pos_credit_memo has NO metadata column. QB data lives in direct columns:
    // qb_txn_id, qb_edit_sequence. The credit_memo_number IS the QB ref number.
    if (type === "return") {
      const { rows } = await client.query(
        `SELECT id, credit_memo_number, order_id, qb_txn_id, qb_edit_sequence
                 FROM pos_credit_memo WHERE id = $1 LIMIT 1`,
        [internalId]
      );
      if (!rows.length) {
        res.status(404).json({ error: `Credit Memo ${internalId} not found` });
        return;
      }
      const cm = rows[0];
      entity_metadata = {
        qb_txn_id: cm.qb_txn_id ?? null,
        qb_ref_number: cm.credit_memo_number ?? null,
        qb_sync_status: null,
        qb_edit_sequence: cm.qb_edit_sequence ?? null,
      };
      display_info = {
        credit_memo_number: cm.credit_memo_number ?? null,
        order_id: cm.order_id ?? null,
      };
    }

    // ── payment (customer_payment) ────────────────────────────────────────
    if (type === "payment") {
      const financeService = req.scope.resolve(FINANCE_MODULE);
      const payment = await financeService
        .retrieveCustomerPayment(internalId)
        .catch(() => null);
      if (!payment) {
        res.status(404).json({ error: `Payment ${internalId} not found` });
        return;
      }
      entity_metadata = (payment as any).metadata ?? {};
      display_info = {
        reference: (payment as any).reference ?? null,
        amount: (payment as any).amount ?? null,
        status: (payment as any).status ?? null,
        customer_id: (payment as any).customer_id ?? null,
      };
    }

    // ── purchase_order ────────────────────────────────────────────────────
    if (type === "purchase_order") {
      const { rows: poRows } = await client.query(
        `SELECT po.id, po.number, po.vendor_name_snapshot, po.status,
                pipe.qb_list_id, pipe.qb_txn_number, pipe.status AS pipe_status
           FROM purchase_order po
           LEFT JOIN qb_purchase_order_pipeline pipe
                  ON pipe.purchase_order_id = po.id AND pipe.deleted_at IS NULL
          WHERE po.id = $1 AND po.deleted_at IS NULL LIMIT 1`,
        [internalId]
      );
      if (!poRows.length) {
        res.status(404).json({ error: `Purchase Order ${internalId} not found` });
        return;
      }
      const po = poRows[0];
      entity_metadata = {
        qb_txn_id:       po.qb_list_id ?? null,
        qb_ref_number:   po.qb_txn_number ?? null,
        qb_sync_status:  po.pipe_status ?? null,
        qb_edit_sequence: null,
      };
      display_info = {
        number:      po.number ?? null,
        vendor:      po.vendor_name_snapshot ?? null,
        status:      po.status ?? null,
        pipe_status: po.pipe_status ?? null,
      };
    }

    // ── inventory_adjustment ──────────────────────────────────────────────
    if (type === "inventory_adjustment") {
      const { rows: icRows } = await client.query(
        `SELECT ic.id, ic.number, ic.memo, ic.status,
                pipe.qb_list_id, pipe.qb_txn_number, pipe.status AS pipe_status
           FROM inventory_count ic
           LEFT JOIN qb_inventory_adjustment_pipeline pipe
                  ON pipe.inventory_count_id = ic.id AND pipe.deleted_at IS NULL
          WHERE ic.id = $1 AND ic.deleted_at IS NULL LIMIT 1`,
        [internalId]
      );
      if (!icRows.length) {
        res.status(404).json({ error: `Inventory Count ${internalId} not found` });
        return;
      }
      const ic = icRows[0];
      entity_metadata = {
        qb_txn_id:       ic.qb_list_id ?? null,
        qb_ref_number:   ic.qb_txn_number ?? null,
        qb_sync_status:  ic.pipe_status ?? null,
        qb_edit_sequence: null,
      };
      display_info = {
        number:      ic.number ?? null,
        memo:        ic.memo ?? null,
        status:      ic.status ?? null,
        pipe_status: ic.pipe_status ?? null,
      };
    }

    // ── item_receipt (purchase_order_receipt) ─────────────────────────────
    if (type === "item_receipt") {
      const { rows: porRows } = await client.query(
        `SELECT por.id, por.number, por.status,
                po.number AS po_number, po.vendor_name_snapshot,
                por.qb_item_receipt_list_id, por.qb_item_receipt_txn_number,
                por.qb_synced_at,
                pipe.status AS pipe_status
           FROM purchase_order_receipt por
           LEFT JOIN purchase_order po ON po.id = por.purchase_order_id
           LEFT JOIN qb_item_receipt_pipeline pipe
                  ON pipe.purchase_order_receipt_id = por.id AND pipe.deleted_at IS NULL
          WHERE por.id = $1 AND por.deleted_at IS NULL LIMIT 1`,
        [internalId]
      );
      if (!porRows.length) {
        res.status(404).json({ error: `Item Receipt ${internalId} not found` });
        return;
      }
      const por = porRows[0];
      entity_metadata = {
        qb_txn_id:       por.qb_item_receipt_list_id ?? null,
        qb_ref_number:   por.qb_item_receipt_txn_number ?? null,
        qb_sync_status:  por.pipe_status ?? null,
        qb_edit_sequence: null,
      };
      display_info = {
        number:     por.number ?? null,
        po_number:  por.po_number ?? null,
        vendor:     por.vendor_name_snapshot ?? null,
        status:     por.status ?? null,
      };
    }

    // ── Extract QB fields ─────────────────────────────────────────────────
    let qbFields: {
      qb_txn_id: string | null;
      qb_ref_number: string | null;
      qb_sync_status: string | null;
      qb_edit_sequence: string | null;
      qb_is_sales_receipt: boolean | null;
    };

    // For returns, metadata was built from direct columns above
    qbFields = extractQbFields(entity_metadata, type as PosDocType);

    // ── Pipeline rows ─────────────────────────────────────────────────────
    // New types (purchase_order, inventory_adjustment, item_receipt) query
    // their own pipeline tables — handled inline, skip qb_order_pipeline.
    const isNewType =
      type === "purchase_order" ||
      type === "inventory_adjustment" ||
      type === "item_receipt";

    let pipelineRows: Array<{
      id: string;
      step: string;
      status: string;
      qb_txn_id: string | null;
      qb_ref_number: string | null;
      error: string | null;
      created_at: string;
      updated_at: string | null;
      confirmed_at: string | null;
      failed_at: string | null;
    }> = [];

    if (isNewType) {
      if (type === "purchase_order") {
        const { rows } = await client.query(
          `SELECT id,
                  CASE WHEN (payload->>'is_void')::boolean = true THEN 'void_purchase_order'
                       WHEN (payload->>'is_mod')::boolean  = true THEN 'mod_purchase_order'
                       ELSE 'purchase_order' END AS step,
                  status, qb_list_id AS qb_txn_id, qb_txn_number AS qb_ref_number,
                  last_error AS error, created_at, updated_at, NULL AS confirmed_at, NULL AS failed_at
             FROM qb_purchase_order_pipeline
            WHERE purchase_order_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 10`,
          [internalId]
        );
        pipelineRows = rows;
      } else if (type === "inventory_adjustment") {
        const { rows } = await client.query(
          `SELECT id, 'inventory_adjustment' AS step, status,
                  qb_list_id AS qb_txn_id, qb_txn_number AS qb_ref_number,
                  last_error AS error, created_at, updated_at, NULL AS confirmed_at, NULL AS failed_at
             FROM qb_inventory_adjustment_pipeline
            WHERE inventory_count_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 10`,
          [internalId]
        );
        pipelineRows = rows;
      } else if (type === "item_receipt") {
        const { rows } = await client.query(
          `SELECT id, 'item_receipt' AS step, status,
                  qb_list_id AS qb_txn_id, qb_txn_number AS qb_ref_number,
                  last_error AS error, created_at, updated_at, NULL AS confirmed_at, NULL AS failed_at
             FROM qb_item_receipt_pipeline
            WHERE purchase_order_receipt_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 10`,
          [internalId]
        );
        pipelineRows = rows;
      }
    } else {
    const stepFilter: Record<
      Exclude<
        PosDocType,
        "purchase_order" | "inventory_adjustment" | "item_receipt" | "customer" | "variant"
      >,
      string
    > = {
      estimate: "step = 'estimate'",
      order:    "step = 'sales_order'",
      invoice:  "step = 'invoice'",
      return:   "step = 'credit_memo'",
      payment:  "step IN ('payment', 'apply_payment')",
    };

    const { rows } = await client.query(
      `
            SELECT id, step, status, qb_txn_id, qb_ref_number, error,
                   created_at, updated_at, confirmed_at, failed_at
            FROM qb_order_pipeline
            WHERE (order_id = $1 OR reference_id = $1)
              AND ${stepFilter[type as keyof typeof stepFilter]}
            ORDER BY created_at DESC
            LIMIT 10
        `,
      [internalId]
    );
    pipelineRows = rows;
    }

    res.json({
      type,
      id: internalId,
      friendly_id: id !== internalId ? id : undefined,
      ...qbFields,
      display_info,
      pipeline_rows: pipelineRows,
    });
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "Failed to load QB metadata";
    console.error(`[QB Metadata GET type=${type} id=${id}]`, error);
    res.status(500).json({ error: msg });
  } finally {
    await client.end();
  }
}

// ─── PUT ─────────────────────────────────────────────────────────────────────

/**
 * PUT /admin/quickbooks/metadata
 *
 * Overwrites QB metadata fields on any POS entity + updates pipeline row.
 *
 * Body: { type, id, qb_txn_id, qb_ref_number, qb_sync_status }
 */
export async function PUT(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const {
    type,
    id,
    qb_txn_id,
    qb_ref_number,
    qb_sync_status,
    qb_edit_sequence,
    qb_is_sales_receipt,
  } = (req.body ?? {}) as {
    type?: string;
    id?: string;
    qb_txn_id?: string | null;
    qb_ref_number?: string | null;
    qb_sync_status?: string | null;
    qb_edit_sequence?: string | null;
    qb_is_sales_receipt?: boolean | null;
  };

  if (!type || !VALID_TYPES.includes(type as PosDocType)) {
    res
      .status(400)
      .json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` });
    return;
  }
  if (!id?.trim()) {
    res.status(400).json({ error: "id is required" });
    return;
  }

  const AUDIT_NOTE = "Manually updated via QB Admin page";
  const now = new Date().toISOString();
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // Resolve friendly ID → internal UUID
    const internalId = await resolveId(client, type as PosDocType, id);
    if (!internalId) {
      res.status(404).json({ error: `${type} "${id}" not found` });
      return;
    }

    // ── customer: write metadata.qb_list_id ───────────────────────────────
    if (type === "customer") {
      const customerModule = req.scope.resolve(Modules.CUSTOMER);
      const customer = await customerModule
        .retrieveCustomer(internalId)
        .catch(() => null);
      if (!customer) {
        res.status(404).json({ error: `Customer ${internalId} not found` });
        return;
      }
      const existingMeta = { ...((customer as any).metadata ?? {}) };
      if (qb_txn_id !== undefined) existingMeta.qb_list_id = qb_txn_id;
      if (qb_edit_sequence !== undefined) existingMeta.qb_edit_sequence = qb_edit_sequence;
      existingMeta.qb_manually_mapped_at = now;
      existingMeta.qb_manually_mapped_note = AUDIT_NOTE;

      await customerModule.updateCustomers(internalId, { metadata: existingMeta });

      // Re-index immediately so the freshly-mapped qb_list_id shows up in POS
      // search. updateCustomers (direct module call) emits no event, so the
      // auto-sync subscriber won't fire on its own. Non-fatal.
      await syncCustomerToMeili(internalId, req.scope);

      res.json({ success: true, type, id: internalId });
      return;
    }

    // ── variant: write metadata.quickbooks_id ─────────────────────────────
    if (type === "variant") {
      const productModule = req.scope.resolve(Modules.PRODUCT);
      const variant = await productModule
        .retrieveProductVariant(internalId)
        .catch(() => null);
      if (!variant) {
        res.status(404).json({ error: `Variant ${internalId} not found` });
        return;
      }
      const existingMeta = { ...((variant as any).metadata ?? {}) };
      if (qb_txn_id !== undefined) existingMeta.quickbooks_id = qb_txn_id;
      existingMeta.qb_manually_mapped_at = now;
      existingMeta.qb_manually_mapped_note = AUDIT_NOTE;

      await productModule.updateProductVariants(internalId, {
        metadata: existingMeta,
      });

      // Re-index the variant into the MeiliSearch `inventory` index so the
      // mapped item reflects immediately in POS Inventory search. The direct
      // module update emits no product-variant event, so the lifecycle
      // subscriber won't fire. Non-fatal — never block the mapping write.
      try {
        await syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
          input: { variantId: internalId },
        });
      } catch (err: any) {
        console.error(
          `[qb-metadata] Meili inventory reindex failed for variant ${internalId}: ${err.message}`
        );
      }

      res.json({ success: true, type, id: internalId });
      return;
    }

    // ── estimate / order ─────────────────────────────────────────────────
    if (type === "estimate" || type === "order") {
      const orderModule = req.scope.resolve(Modules.ORDER);
      const order = await orderModule
        .retrieveOrder(internalId)
        .catch(() => null);
      if (!order) {
        res.status(404).json({ error: `Order ${id} not found` });
        return;
      }

      const existingMeta: Record<string, unknown> = {
        ...((order as any).metadata ?? {}),
      };

      if (type === "estimate") {
        const existingEst =
          typeof existingMeta.qb_estimate === "object" &&
          existingMeta.qb_estimate !== null &&
          !Array.isArray(existingMeta.qb_estimate)
            ? { ...(existingMeta.qb_estimate as Record<string, unknown>) }
            : { operation_id: null, edit_sequence: null, synced_at: now };

        existingMeta.qb_estimate = {
          ...existingEst,
          ...(qb_txn_id !== undefined ? { txn_id: qb_txn_id } : {}),
          ...(qb_ref_number !== undefined ? { ref_number: qb_ref_number } : {}),
          ...(qb_edit_sequence !== undefined
            ? { edit_sequence: qb_edit_sequence }
            : {}),
          synced_at: now,
        };
      } else {
        const existingSo =
          typeof existingMeta.qb_sales_order === "object" &&
          existingMeta.qb_sales_order !== null &&
          !Array.isArray(existingMeta.qb_sales_order)
            ? { ...(existingMeta.qb_sales_order as Record<string, unknown>) }
            : { operation_id: null, edit_sequence: null, synced_at: now };

        existingMeta.qb_sales_order = {
          ...existingSo,
          ...(qb_txn_id !== undefined ? { txn_id: qb_txn_id } : {}),
          ...(qb_ref_number !== undefined ? { ref_number: qb_ref_number } : {}),
          ...(qb_edit_sequence !== undefined
            ? { edit_sequence: qb_edit_sequence }
            : {}),
          synced_at: now,
        };
      }

      if (qb_sync_status !== undefined) {
        existingMeta.qb_sync_status = qb_sync_status;
      }
      existingMeta.qb_synced_at = now;

      await orderModule.updateOrders(internalId, { metadata: existingMeta });
    }

    // ── invoice (pos_invoice) ─────────────────────────────────────────────
    if (type === "invoice") {
      const invoiceService = req.scope.resolve(INVOICE_MODULE);
      const [invoice] = await invoiceService
        .listPosInvoices({ id: [internalId] })
        .catch(() => []);
      if (!invoice) {
        res.status(404).json({ error: `Invoice ${internalId} not found` });
        return;
      }

      const existingMeta: Record<string, unknown> = {
        ...((invoice as any).metadata ?? {}),
      };

      if (qb_txn_id !== undefined) existingMeta.qb_invoice_txn_id = qb_txn_id;
      if (qb_ref_number !== undefined)
        existingMeta.qb_ref_number = qb_ref_number;
      if (qb_sync_status !== undefined)
        existingMeta.qb_sync_status = qb_sync_status;
      if (qb_edit_sequence !== undefined)
        existingMeta.qb_edit_sequence = qb_edit_sequence;
      if (qb_is_sales_receipt !== undefined)
        existingMeta.qb_is_sales_receipt = qb_is_sales_receipt;

      await invoiceService.updatePosInvoices({
        id: internalId,
        metadata: existingMeta,
      });
    }

    // ── return (pos_credit_memo) ─────────────────────────────────────────
    if (type === "return") {
      // pos_credit_memo has no metadata column — only direct columns
      const updates: string[] = [`updated_at = NOW()`];
      const values: unknown[] = [internalId];

      if (qb_txn_id !== undefined) {
        updates.push(`qb_txn_id = $${values.length + 1}`);
        values.push(qb_txn_id);
      }
      if (qb_edit_sequence !== undefined) {
        updates.push(`qb_edit_sequence = $${values.length + 1}`);
        values.push(qb_edit_sequence);
      }

      const { rowCount } = await client.query(
        `UPDATE pos_credit_memo SET ${updates.join(", ")} WHERE id = $1`,
        values
      );
      if (!rowCount) {
        res.status(404).json({ error: `Credit Memo ${internalId} not found` });
        return;
      }
    }

    // ── payment (customer_payment) ────────────────────────────────────────
    if (type === "payment") {
      const financeService = req.scope.resolve(FINANCE_MODULE);
      const payment = await financeService
        .retrieveCustomerPayment(internalId)
        .catch(() => null);
      if (!payment) {
        res.status(404).json({ error: `Payment ${internalId} not found` });
        return;
      }

      const existingMeta: Record<string, unknown> = {
        ...((payment as any).metadata ?? {}),
      };

      if (qb_txn_id !== undefined) existingMeta.qb_txn_id = qb_txn_id;
      if (qb_ref_number !== undefined)
        existingMeta.qb_ref_number = qb_ref_number;
      if (qb_sync_status !== undefined)
        existingMeta.qb_sync_status = qb_sync_status;
      if (qb_edit_sequence !== undefined)
        existingMeta.qb_edit_sequence = qb_edit_sequence;

      await financeService.updateCustomerPayments({
        id: internalId,
        metadata: existingMeta,
      });
    }

    // ── purchase_order (pipeline row) ─────────────────────────────────────
    if (type === "purchase_order") {
      const updates: string[] = ["updated_at = NOW()"];
      const vals: unknown[] = [internalId];
      let idx = 2;
      if (qb_txn_id !== undefined)      { updates.push(`qb_list_id = $${idx++}`);    vals.push(qb_txn_id); }
      if (qb_ref_number !== undefined)  { updates.push(`qb_txn_number = $${idx++}`); vals.push(qb_ref_number); }
      if (qb_txn_id || qb_ref_number)  { updates.push(`status = 'synced'`, `synced_at = NOW()`); }

      await client.query(
        `UPDATE qb_purchase_order_pipeline SET ${updates.join(", ")}
          WHERE purchase_order_id = $1 AND deleted_at IS NULL`,
        vals
      );
      res.json({ success: true, updated: { type, id, qb_txn_id, qb_ref_number, note: AUDIT_NOTE } });
      return;
    }

    // ── inventory_adjustment (pipeline row) ────────────────────────────────
    if (type === "inventory_adjustment") {
      const updates: string[] = ["updated_at = NOW()"];
      const vals: unknown[] = [internalId];
      let idx = 2;
      if (qb_txn_id !== undefined)     { updates.push(`qb_list_id = $${idx++}`);    vals.push(qb_txn_id); }
      if (qb_ref_number !== undefined) { updates.push(`qb_txn_number = $${idx++}`); vals.push(qb_ref_number); }
      if (qb_txn_id || qb_ref_number) { updates.push(`status = 'synced'`, `synced_at = NOW()`); }

      await client.query(
        `UPDATE qb_inventory_adjustment_pipeline SET ${updates.join(", ")}
          WHERE inventory_count_id = $1 AND deleted_at IS NULL`,
        vals
      );
      res.json({ success: true, updated: { type, id, qb_txn_id, qb_ref_number, note: AUDIT_NOTE } });
      return;
    }

    // ── item_receipt (purchase_order_receipt + pipeline row) ───────────────
    if (type === "item_receipt") {
      await client.query("BEGIN");
      try {
        if (qb_txn_id !== undefined || qb_ref_number !== undefined) {
          const colUpdates: string[] = ["updated_at = NOW()"];
          const vals: unknown[] = [internalId];
          let idx = 2;
          if (qb_txn_id !== undefined)     { colUpdates.push(`qb_item_receipt_list_id = $${idx++}`);    vals.push(qb_txn_id); }
          if (qb_ref_number !== undefined) { colUpdates.push(`qb_item_receipt_txn_number = $${idx++}`); vals.push(qb_ref_number); }
          if (qb_txn_id || qb_ref_number) { colUpdates.push(`qb_synced_at = NOW()`); }
          await client.query(
            `UPDATE purchase_order_receipt SET ${colUpdates.join(", ")} WHERE id = $1`,
            vals
          );

          const pipeUpdates: string[] = ["updated_at = NOW()"];
          const pVals: unknown[] = [internalId];
          let pIdx = 2;
          if (qb_txn_id !== undefined)     { pipeUpdates.push(`qb_list_id = $${pIdx++}`);    pVals.push(qb_txn_id); }
          if (qb_ref_number !== undefined) { pipeUpdates.push(`qb_txn_number = $${pIdx++}`); pVals.push(qb_ref_number); }
          if (qb_txn_id || qb_ref_number) { pipeUpdates.push(`status = 'synced'`, `synced_at = NOW()`); }
          await client.query(
            `UPDATE qb_item_receipt_pipeline SET ${pipeUpdates.join(", ")}
              WHERE purchase_order_receipt_id = $1 AND deleted_at IS NULL`,
            pVals
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
      res.json({ success: true, updated: { type, id, qb_txn_id, qb_ref_number, note: AUDIT_NOTE } });
      return;
    }

    // ── Update pipeline rows ──────────────────────────────────────────────
    const stepFilter: Record<
      Exclude<
        PosDocType,
        "purchase_order" | "inventory_adjustment" | "item_receipt" | "customer" | "variant"
      >,
      string
    > = {
      estimate: "step = 'estimate'",
      order:    "step = 'sales_order'",
      invoice:  "step = 'invoice'",
      return:   "step = 'credit_memo'",
      payment:  "step IN ('payment', 'apply_payment')",
    };

    const pipelineUpdates: string[] = [`error = $2`, `updated_at = NOW()`];
    const pipelineValues: unknown[] = [internalId, AUDIT_NOTE];
    let pIdx = 3;

    if (qb_txn_id !== undefined) {
      pipelineUpdates.push(`qb_txn_id = $${pIdx++}`);
      pipelineValues.push(qb_txn_id);
    }
    if (qb_ref_number !== undefined) {
      pipelineUpdates.push(`qb_ref_number = $${pIdx++}`);
      pipelineValues.push(qb_ref_number);
    }

    await client.query(
      `
            UPDATE qb_order_pipeline
            SET ${pipelineUpdates.join(", ")}
            WHERE (order_id = $1 OR reference_id = $1)
              AND ${stepFilter[type as keyof typeof stepFilter]}
              AND status NOT IN ('waiting')
        `,
      pipelineValues
    );

    res.json({
      success: true,
      updated: {
        type,
        id,
        qb_txn_id,
        qb_ref_number,
        qb_sync_status,
        qb_edit_sequence,
        note: AUDIT_NOTE,
      },
    });
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "Failed to update QB metadata";
    console.error(`[QB Metadata PUT type=${type} id=${id}]`, error);
    res.status(500).json({ error: msg });
  } finally {
    await client.end();
  }
}
