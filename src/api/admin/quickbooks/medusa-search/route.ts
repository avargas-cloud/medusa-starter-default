import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

type PosDocType = "estimate" | "order" | "invoice" | "return" | "payment";

const VALID_TYPES: PosDocType[] = [
  "estimate",
  "order",
  "invoice",
  "return",
  "payment",
];

interface SearchHit {
  id:               string;
  display_id:       string;
  label:            string;
  date:             string | null;
  amount:           number | null;
  customer_name:    string | null;
  already_mapped:   boolean;
  existing_txn_id:  string | null;
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
    res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` });
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
  if (type === "estimate") return searchOrderLike(client, q, "estimate", "E");
  if (type === "order")    return searchOrderLike(client, q, "order", "S");
  if (type === "invoice")  return searchInvoice(client, q);
  if (type === "return")   return searchReturn(client, q);
  if (type === "payment")  return searchPayment(client, q);
  return [];
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
  const statusPredicate = mode === "estimate"
    ? `is_draft_order = TRUE`
    : `is_draft_order = FALSE`;

  const params: unknown[] = [];
  let wherePattern = "";
  if (q) {
    const upper = q.toUpperCase();
    const withPrefix = upper.startsWith(prefix) ? upper : `${prefix}${upper}`;
    params.push(`${upper}%`, `${withPrefix}%`);
    wherePattern = `AND (metadata->>'document_number' ILIKE $1 OR metadata->>'document_number' ILIKE $2)`;
  }

  const { rows } = await client.query<{
    id:              string;
    document_number: string | null;
    display_id:      number | null;
    email:           string | null;
    created_at:      Date;
    qb_txn_id:       string | null;
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

  return rows.map(r => {
    const docNum  = r.document_number || (r.display_id != null ? String(r.display_id) : r.id);
    return {
      id:              r.id,
      display_id:      docNum,
      label:           docNum,
      date:            r.created_at?.toISOString() ?? null,
      amount:          null,
      customer_name:   r.email,
      already_mapped:  !!r.qb_txn_id,
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
    id:             string;
    invoice_number: string | null;
    total:          string | number | null;
    created_at:     Date;
    metadata:       Record<string, unknown> | null;
  }>(
    `SELECT id, invoice_number, total, created_at, metadata
       FROM pos_invoice
       ${wherePattern}
      ORDER BY created_at DESC
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map(r => {
    const num      = r.invoice_number ?? r.id;
    const amount   = r.total != null ? Number(r.total) / 100 : null; // cents → dollars
    const txnId    = (r.metadata?.qb_txn_id as string | undefined) ?? null;
    return {
      id:              r.id,
      display_id:      num,
      label:           num,
      date:            r.created_at?.toISOString() ?? null,
      amount,
      customer_name:   null,
      already_mapped:  !!txnId,
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
    id:                 string;
    credit_memo_number: string | null;
    total:              string | number | null;
    created_at:         Date;
    qb_txn_id:          string | null;
  }>(
    `SELECT id, credit_memo_number, total, created_at, qb_txn_id
       FROM pos_credit_memo
       ${wherePattern}
      ORDER BY created_at DESC
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map(r => {
    const num      = r.credit_memo_number ?? r.id;
    const amount   = r.total != null ? Number(r.total) / 100 : null;
    return {
      id:              r.id,
      display_id:      num,
      label:           num,
      date:            r.created_at?.toISOString() ?? null,
      amount,
      customer_name:   null,
      already_mapped:  !!r.qb_txn_id,
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
    id:         string;
    display_id: number | null;
    reference:  string | null;
    amount:     string | number | null;
    created_at: Date;
    metadata:   Record<string, unknown> | null;
  }>(
    `SELECT id, display_id, reference, amount, created_at, metadata
       FROM customer_payment
       ${wherePattern}
      ORDER BY created_at DESC
      LIMIT ${LIMIT}`,
    params
  );

  return rows.map(r => {
    const num      = r.display_id != null ? String(r.display_id) : (r.reference ?? r.id);
    const amount   = r.amount != null ? Number(r.amount) / 100 : null;
    const txnId    = (r.metadata?.qb_txn_id as string | undefined) ?? null;
    return {
      id:              r.id,
      display_id:      num,
      label:           r.reference ? `${num} · ${r.reference}` : num,
      date:            r.created_at?.toISOString() ?? null,
      amount,
      customer_name:   null,
      already_mapped:  !!txnId,
      existing_txn_id: txnId,
    };
  });
}
