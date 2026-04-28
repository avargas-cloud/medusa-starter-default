import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

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

interface SearchHit {
  id: string;
  display_id: string;
  label: string;
  date: string | null;
  amount: number | null;
  customer_name: string | null;
  already_mapped: boolean;
  existing_txn_id: string | null;
}

const LIMIT = 20;

/**
 * GET /admin/quickbooks/medusa-search?type=<posType>&q=<query>
 *
 * Lightweight search over Medusa documents (estimates, orders, invoices,
 * credit memos, payments) to feed the auto-mapper UI on the QuickBooks page.
 *
 * Match strategy per type:
 *   - estimate → "order" table, metadata->>'document_number' starts with query (E-prefixed)
 *   - order    → "order" table, metadata->>'document_number' starts with query (S-prefixed)
 *   - invoice  → pos_invoice.invoice_number starts with query
 *   - return   → pos_credit_memo.credit_memo_number starts with query
 *   - payment  → customer_payment.display_id starts with query (numeric)
 *
 * Empty query returns the 20 most recent records for that type.
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const type = req.query.type as string | undefined;
  const rawQ = (req.query.q as string | undefined) ?? "";
  const q = rawQ.trim();

  if (!type || !VALID_TYPES.includes(type as PosDocType)) {
    res
      .status(400)
      .json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    const results = await search(client, type as PosDocType, q);
    res.json({ results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Search failed";
    res.status(500).json({ error: msg });
  } finally {
    await client.end().catch(() => {});
  }
}

async function search(
  client: InstanceType<typeof Client>,
  type: PosDocType,
  q: string
): Promise<SearchHit[]> {
  if (type === "estimate")            return searchOrderLike(client, q, "estimate", "E");
  if (type === "order")               return searchOrderLike(client, q, "order", "S");
  if (type === "invoice")             return searchInvoice(client, q);
  if (type === "return")              return searchReturn(client, q);
  if (type === "payment")             return searchPayment(client, q);
  if (type === "purchase_order")      return searchPurchaseOrder(client, q);
  if (type === "inventory_adjustment") return searchInventoryAdjustment(client, q);
  if (type === "item_receipt")        return searchItemReceipt(client, q);
  if (type === "customer")            return searchCustomer(client, q);
  if (type === "variant")             return searchVariant(client, q);
  return [];
}

async function searchCustomer(
  client: InstanceType<typeof Client>,
  q: string
): Promise<SearchHit[]> {
  const params: unknown[] = [];
  let wherePattern = "";
  if (q) {
    params.push(`%${q}%`);
    wherePattern = `AND (
      email ILIKE $1
      OR company_name ILIKE $1
      OR (COALESCE(first_name,'')||' '||COALESCE(last_name,'')) ILIKE $1
    )`;
  }

  const { rows } = await client.query<{
    id: string;
    email: string | null;
    company_name: string | null;
    first_name: string | null;
    last_name: string | null;
    qb_list_id: string | null;
    created_at: Date;
  }>(
    `SELECT id, email, company_name, first_name, last_name,
            metadata->>'qb_list_id' AS qb_list_id,
            created_at
       FROM customer
      WHERE deleted_at IS NULL
      ${wherePattern}
      ORDER BY created_at DESC
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map((r) => {
    const fullName = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
    const display = r.company_name || fullName || r.email || r.id;
    return {
      id: r.id,
      display_id: display,
      label: display,
      date: r.created_at?.toISOString() ?? null,
      amount: null,
      customer_name: r.email,
      already_mapped: !!r.qb_list_id,
      existing_txn_id: r.qb_list_id,
    };
  });
}

async function searchVariant(
  client: InstanceType<typeof Client>,
  q: string
): Promise<SearchHit[]> {
  const params: unknown[] = [];
  let wherePattern = "";
  if (q) {
    params.push(`%${q}%`);
    wherePattern = `AND (
      pv.sku ILIKE $1 OR pv.title ILIKE $1 OR p.title ILIKE $1
    )`;
  }

  const { rows } = await client.query<{
    id: string;
    sku: string | null;
    variant_title: string | null;
    product_title: string | null;
    quickbooks_id: string | null;
    created_at: Date;
  }>(
    `SELECT pv.id,
            pv.sku,
            pv.title AS variant_title,
            p.title AS product_title,
            pv.metadata->>'quickbooks_id' AS quickbooks_id,
            pv.created_at
       FROM product_variant pv
       JOIN product p ON p.id = pv.product_id
      WHERE pv.deleted_at IS NULL
      ${wherePattern}
      ORDER BY pv.created_at DESC
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    display_id: r.sku || r.id,
    label: r.sku || r.id,
    date: r.created_at?.toISOString() ?? null,
    amount: null,
    customer_name: r.product_title || r.variant_title,
    already_mapped: !!r.quickbooks_id,
    existing_txn_id: r.quickbooks_id,
  }));
}

async function searchOrderLike(
  client: InstanceType<typeof Client>,
  q: string,
  mode: "estimate" | "order",
  prefix: "E" | "S"
): Promise<SearchHit[]> {
  // Medusa v2 distinguishes estimates from sales orders via `is_draft_order`,
  // NOT by `status` — canceled estimates keep is_draft_order=true and
  // status='canceled', so a status-based filter leaks them into order results.
  const statusPredicate =
    mode === "estimate" ? `is_draft_order = TRUE` : `is_draft_order = FALSE`;

  const params: unknown[] = [];
  let wherePattern = "";
  if (q) {
    const upper = q.toUpperCase();
    const withPrefix = upper.startsWith(prefix) ? upper : `${prefix}${upper}`;
    params.push(`${upper}%`, `${withPrefix}%`);
    wherePattern = `AND (metadata->>'document_number' ILIKE $1 OR metadata->>'document_number' ILIKE $2)`;
  }

  const { rows } = await client.query<{
    id: string;
    document_number: string | null;
    display_id: number | null;
    email: string | null;
    created_at: Date;
    qb_txn_id: string | null;
  }>(
    `SELECT id,
            metadata->>'document_number' AS document_number,
            display_id,
            email,
            created_at,
            metadata->>'qb_txn_id' AS qb_txn_id
       FROM "order"
      WHERE ${statusPredicate}
      ${wherePattern}
      ORDER BY created_at DESC
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map((r) => {
    const docNum =
      r.document_number || (r.display_id != null ? String(r.display_id) : r.id);
    return {
      id: r.id,
      display_id: docNum,
      label: docNum,
      date: r.created_at?.toISOString() ?? null,
      amount: null,
      customer_name: r.email,
      already_mapped: !!r.qb_txn_id,
      existing_txn_id: r.qb_txn_id,
    };
  });
}

async function searchInvoice(
  client: InstanceType<typeof Client>,
  q: string
): Promise<SearchHit[]> {
  const params: unknown[] = [];
  let wherePattern = "";
  if (q) {
    params.push(`${q}%`);
    wherePattern = `WHERE invoice_number ILIKE $1`;
  }

  const { rows } = await client.query<{
    id: string;
    invoice_number: string | null;
    total: string | number | null;
    created_at: Date;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id, invoice_number, total, created_at, metadata
       FROM pos_invoice
       ${wherePattern}
      ORDER BY created_at DESC
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map((r) => {
    const num = r.invoice_number ?? r.id;
    const amount = r.total != null ? Number(r.total) / 100 : null; // cents → dollars
    const txnId = (r.metadata?.qb_txn_id as string | undefined) ?? null;
    return {
      id: r.id,
      display_id: num,
      label: num,
      date: r.created_at?.toISOString() ?? null,
      amount,
      customer_name: null,
      already_mapped: !!txnId,
      existing_txn_id: txnId,
    };
  });
}

async function searchReturn(
  client: InstanceType<typeof Client>,
  q: string
): Promise<SearchHit[]> {
  const params: unknown[] = [];
  let wherePattern = "";
  if (q) {
    const upper = q.toUpperCase();
    const withCM = upper.startsWith("CM") ? upper : `CM-${upper}`;
    params.push(`${upper}%`, `${withCM}%`);
    wherePattern = `WHERE credit_memo_number ILIKE $1 OR credit_memo_number ILIKE $2`;
  }

  const { rows } = await client.query<{
    id: string;
    credit_memo_number: string | null;
    total: string | number | null;
    created_at: Date;
    qb_txn_id: string | null;
  }>(
    `SELECT id, credit_memo_number, total, created_at, qb_txn_id
       FROM pos_credit_memo
       ${wherePattern}
      ORDER BY created_at DESC
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map((r) => {
    const num = r.credit_memo_number ?? r.id;
    const amount = r.total != null ? Number(r.total) / 100 : null;
    return {
      id: r.id,
      display_id: num,
      label: num,
      date: r.created_at?.toISOString() ?? null,
      amount,
      customer_name: null,
      already_mapped: !!r.qb_txn_id,
      existing_txn_id: r.qb_txn_id,
    };
  });
}

async function searchPayment(
  client: InstanceType<typeof Client>,
  q: string
): Promise<SearchHit[]> {
  const params: unknown[] = [];
  let wherePattern = "";
  if (q) {
    params.push(`${q}%`);
    wherePattern = `WHERE CAST(display_id AS TEXT) ILIKE $1 OR reference ILIKE $1`;
  }

  const { rows } = await client.query<{
    id: string;
    display_id: number | null;
    reference: string | null;
    amount: string | number | null;
    created_at: Date;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id, display_id, reference, amount, created_at, metadata
       FROM customer_payment
       ${wherePattern}
      ORDER BY created_at DESC
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map((r) => {
    const num =
      r.display_id != null ? String(r.display_id) : (r.reference ?? r.id);
    const amount = r.amount != null ? Number(r.amount) / 100 : null;
    const txnId = (r.metadata?.qb_txn_id as string | undefined) ?? null;
    return {
      id: r.id,
      display_id: num,
      label: r.reference ? `${num} · ${r.reference}` : num,
      date: r.created_at?.toISOString() ?? null,
      amount,
      customer_name: null,
      already_mapped: !!txnId,
      existing_txn_id: txnId,
    };
  });
}

async function searchPurchaseOrder(
  client: InstanceType<typeof Client>,
  q: string
): Promise<SearchHit[]> {
  const params: unknown[] = [];
  let whereFilter = "";
  if (q) {
    const upper = q.toUpperCase();
    params.push(`${upper}%`);
    whereFilter = `AND po.number ILIKE $1`;
  }

  const { rows } = await client.query<{
    po_id: string;
    po_number: string | null;
    vendor_name: string | null;
    total_cents: number | null;
    submitted_at: Date | null;
    qb_list_id: string | null;
    qb_txn_number: string | null;
  }>(
    `SELECT po.id        AS po_id,
            po.number    AS po_number,
            po.vendor_name_snapshot AS vendor_name,
            po.total_cents,
            po.submitted_at,
            pipe.qb_list_id,
            pipe.qb_txn_number
       FROM purchase_order po
       LEFT JOIN qb_purchase_order_pipeline pipe
              ON pipe.purchase_order_id = po.id
             AND pipe.deleted_at IS NULL
      WHERE po.deleted_at IS NULL
        AND po.status != 'draft'
        ${whereFilter}
      ORDER BY po.submitted_at DESC NULLS LAST
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map((r) => ({
    id:              r.po_id,
    display_id:      r.po_number ?? r.po_id,
    label:           r.po_number ?? r.po_id,
    date:            r.submitted_at?.toISOString() ?? null,
    amount:          r.total_cents != null ? r.total_cents / 100 : null,
    customer_name:   r.vendor_name,
    already_mapped:  !!r.qb_list_id,
    existing_txn_id: r.qb_list_id,
  }));
}

async function searchInventoryAdjustment(
  client: InstanceType<typeof Client>,
  q: string
): Promise<SearchHit[]> {
  const params: unknown[] = [];
  let whereFilter = "";
  if (q) {
    params.push(`${q}%`);
    whereFilter = `AND ic.number ILIKE $1`;
  }

  const { rows } = await client.query<{
    ic_id: string;
    ic_number: string | null;
    ic_memo: string | null;
    submitted_at: Date | null;
    qb_list_id: string | null;
    qb_txn_number: string | null;
  }>(
    `SELECT ic.id          AS ic_id,
            ic.number      AS ic_number,
            ic.memo        AS ic_memo,
            ic.submitted_at,
            pipe.qb_list_id,
            pipe.qb_txn_number
       FROM inventory_count ic
       LEFT JOIN qb_inventory_adjustment_pipeline pipe
              ON pipe.inventory_count_id = ic.id
             AND pipe.deleted_at IS NULL
      WHERE ic.deleted_at IS NULL
        ${whereFilter}
      ORDER BY ic.submitted_at DESC NULLS LAST
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map((r) => ({
    id:              r.ic_id,
    display_id:      r.ic_number ?? r.ic_id,
    label:           r.ic_memo ? `${r.ic_number} · ${r.ic_memo}` : (r.ic_number ?? r.ic_id),
    date:            r.submitted_at?.toISOString() ?? null,
    amount:          null,
    customer_name:   r.ic_memo,
    already_mapped:  !!r.qb_list_id,
    existing_txn_id: r.qb_list_id,
  }));
}

async function searchItemReceipt(
  client: InstanceType<typeof Client>,
  q: string
): Promise<SearchHit[]> {
  const params: unknown[] = [];
  let whereFilter = "";
  if (q) {
    const upper = q.toUpperCase();
    params.push(`${upper}%`);
    whereFilter = `AND por.number ILIKE $1`;
  }

  const { rows } = await client.query<{
    por_id: string;
    por_number: string | null;
    vendor_name: string | null;
    received_at: Date | null;
    qb_item_receipt_list_id: string | null;
    qb_item_receipt_txn_number: string | null;
  }>(
    `SELECT por.id          AS por_id,
            por.number      AS por_number,
            po.vendor_name_snapshot AS vendor_name,
            por.received_at,
            por.qb_item_receipt_list_id,
            por.qb_item_receipt_txn_number
       FROM purchase_order_receipt por
       LEFT JOIN purchase_order po ON po.id = por.purchase_order_id
      WHERE por.deleted_at IS NULL
        ${whereFilter}
      ORDER BY por.received_at DESC NULLS LAST
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map((r) => ({
    id:              r.por_id,
    display_id:      r.por_number ?? r.por_id,
    label:           r.por_number ?? r.por_id,
    date:            r.received_at?.toISOString() ?? null,
    amount:          null,
    customer_name:   r.vendor_name,
    already_mapped:  !!r.qb_item_receipt_list_id,
    existing_txn_id: r.qb_item_receipt_list_id,
  }));
}
