/**
 * src/lib/cost/restatement/load-restatement-data.ts
 *
 * Every read the restatement performs, in one place, against a frozen cutoff.
 *
 * The cutoff is what makes a dry-run and its later apply comparable: both see
 * exactly the same movements, so if the numbers differ, the source data moved
 * and the run must be regenerated rather than applied against a moved target.
 *
 * All queries go through knex (`__pg_connection__`), which binds with `?`.
 * The pg pool binds with `$1` — mixing them throws "Expected 1 bindings, saw 0".
 */

export interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
}

export interface ScopeVariantRow {
  variant_id: string;
  sku: string | null;
  qb_avg_cost: string | null;
  average_cost: string | null;
  average_cost_source: string | null;
  purchase_cost: string | null;
  miami_qty: number | string | null;
  china_qty: number | string | null;
}

/**
 * Variants in scope plus the anchor cost and today's pool quantity.
 *
 * `miami_qty` is the costing pool. `china_qty` is carried only so the
 * reconciliation can name the units it is NOT valuing at the Miami landed
 * average, instead of leaving them as an unexplained difference.
 */
export const SCOPE_SQL = `
SELECT pv.id AS variant_id,
       pv.sku,
       NULLIF(pv.metadata->>'qb_avg_cost','')        AS qb_avg_cost,
       NULLIF(pv.metadata->>'average_cost','')       AS average_cost,
       NULLIF(pv.metadata->>'average_cost_source','') AS average_cost_source,
       NULLIF(pv.metadata->>'purchase_cost','')      AS purchase_cost,
       COALESCE((
         SELECT SUM(il.stocked_quantity)
           FROM inventory_level il
           JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
           JOIN stock_location sl ON sl.id = il.location_id
          WHERE pvii.variant_id = pv.id AND il.deleted_at IS NULL
            AND sl.name = 'Ecopowertech Miami'
       ), 0) AS miami_qty,
       COALESCE((
         SELECT SUM(il.stocked_quantity)
           FROM inventory_level il
           JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
           JOIN stock_location sl ON sl.id = il.location_id
          WHERE pvii.variant_id = pv.id AND il.deleted_at IS NULL
            AND sl.name = 'China Warehouse'
       ), 0) AS china_qty
  FROM product_variant pv
  JOIN product p ON p.id = pv.product_id
 WHERE pv.deleted_at IS NULL
   AND COALESCE((p.metadata->>'is_sourced_via_agent') = 'true', false)
 ORDER BY pv.sku
`;

export interface CostChangeRow {
  source_id: string;
  variant_id: string;
  vendor_bill_id: string;
  receipt_id: string | null;
  received_at: string | null;
  applied_at: string;
  received_qty: number | string;
  landed_unit_cost_cents: number | string;
}

/**
 * The landed-cost receipts that move a variant's carrying cost.
 *
 * Source is `vendor_bill_cost_log`, but ONLY its observed facts: how many units
 * and what one landed unit cost. Its `prev_avg_cost_cents`/`new_avg_cost_cents`
 * are the corrupted output being replaced and are deliberately not selected.
 *
 * `received_at` comes from the bill's anchor receipt and is the economic date;
 * `applied_at` (the confirm) is kept as `recorded_at`. A row whose bill was
 * reversed never happened.
 */
export const COST_CHANGES_SQL = `
SELECT l.id                       AS source_id,
       l.product_variant_id       AS variant_id,
       l.vendor_bill_id,
       vb.purchase_order_receipt_id AS receipt_id,
       r.received_at,
       l.applied_at,
       l.received_qty,
       l.landed_unit_cost_cents
  FROM vendor_bill_cost_log l
  JOIN vendor_bill vb ON vb.id = l.vendor_bill_id AND vb.deleted_at IS NULL
  LEFT JOIN purchase_order_receipt r
         ON r.id = vb.purchase_order_receipt_id AND r.deleted_at IS NULL AND r.voided_at IS NULL
 WHERE l.reversed_at IS NULL
   AND l.applied_at <= ?
   AND l.received_qty > 0
 ORDER BY l.product_variant_id, COALESCE(r.received_at, l.applied_at), l.id
`;

export interface SaleLineRow {
  line_id: string;
  document_id: string;
  variant_id: string | null;
  sku: string | null;
  quantity: number | string;
  average_unit_cost: string | null;
  economic_posted_at: string;
  original_unit_cost: string | null;
  parent_invoice_line_id: string | null;
}

/**
 * China invoice lines with their economic date and, when a previous run already
 * restated them, the ORIGINAL pre-restatement cost so it is never recaptured
 * from an already-modified column.
 *
 * Voided invoices are excluded: they carry no COGS.
 */
export const INVOICE_LINES_SQL = `
SELECT ii.id                                  AS line_id,
       ii.invoice_id                          AS document_id,
       pv.id                                  AS variant_id,
       ii.sku,
       ii.quantity,
       ii.average_unit_cost::text             AS average_unit_cost,
       COALESCE(i.issued_at, i.created_at)    AS economic_posted_at,
       adj.original_unit_cost::text           AS original_unit_cost,
       NULL::text                             AS parent_invoice_line_id
  FROM pos_invoice_item ii
  JOIN pos_invoice i ON i.id = ii.invoice_id
  JOIN product_variant pv ON pv.sku = ii.sku
  JOIN product p ON p.id = pv.product_id
  LEFT JOIN LATERAL (
    SELECT a.original_unit_cost
      FROM sale_cost_adjustment a
     WHERE a.source_type = 'invoice_item' AND a.source_line_id = ii.id
     ORDER BY a.created_at ASC
     LIMIT 1
  ) adj ON true
 WHERE ii.deleted_at IS NULL AND i.deleted_at IS NULL AND pv.deleted_at IS NULL
   AND i.voided_at IS NULL
   AND COALESCE((p.metadata->>'is_sourced_via_agent') = 'true', false)
   AND COALESCE(i.issued_at, i.created_at) <= ?
 ORDER BY COALESCE(i.issued_at, i.created_at), ii.id
`;

/**
 * China credit-memo lines, each resolved to the invoice line it reverses.
 *
 * The parent match is (parent invoice of the memo, same SKU). Where the memo has
 * no parent invoice or the SKU is not on it, `parent_invoice_line_id` is NULL
 * and the caller falls back to return-date pricing WITH an exception — a return
 * must normally reverse the cost basis of the units it sends back.
 */
export const CREDIT_MEMO_LINES_SQL = `
SELECT cmi.id                                  AS line_id,
       cmi.credit_memo_id                      AS document_id,
       pv.id                                   AS variant_id,
       cmi.sku,
       cmi.quantity,
       cmi.average_unit_cost::text             AS average_unit_cost,
       COALESCE(cm.completed_at, cm.created_at) AS economic_posted_at,
       adj.original_unit_cost::text            AS original_unit_cost,
       parent.id                               AS parent_invoice_line_id
  FROM pos_credit_memo_item cmi
  JOIN pos_credit_memo cm ON cm.id = cmi.credit_memo_id
  JOIN product_variant pv ON pv.sku = cmi.sku
  JOIN product p ON p.id = pv.product_id
  LEFT JOIN LATERAL (
    SELECT x.id FROM pos_invoice_item x
     WHERE x.invoice_id = cm.invoice_id AND x.sku = cmi.sku AND x.deleted_at IS NULL
     ORDER BY x.id
     LIMIT 1
  ) parent ON true
  LEFT JOIN LATERAL (
    SELECT a.original_unit_cost
      FROM sale_cost_adjustment a
     WHERE a.source_type = 'credit_memo_item' AND a.source_line_id = cmi.id
     ORDER BY a.created_at ASC
     LIMIT 1
  ) adj ON true
 WHERE cmi.deleted_at IS NULL AND cm.deleted_at IS NULL AND pv.deleted_at IS NULL
   AND cm.voided_at IS NULL
   AND COALESCE((p.metadata->>'is_sourced_via_agent') = 'true', false)
   AND COALESCE(cm.completed_at, cm.created_at) <= ?
 ORDER BY COALESCE(cm.completed_at, cm.created_at), cmi.id
`;

/**
 * Treasury days whose COGS snapshot is locked. Restating a cost inside one of
 * these must NOT silently mutate the locked figure — the locked snapshot is
 * served from its own stored JSON and is audit evidence. The run reports the
 * delta per locked day so a revision can be created deliberately.
 */
export const LOCKED_TREASURY_DAYS_SQL = `
SELECT to_regclass('treasury_day_lock') IS NOT NULL AS has_table
`;

/**
 * A DRY RUN MUST NOT REQUIRE A SCHEMA CHANGE. `sale_cost_adjustment` only
 * exists once the restatement migration has been applied, but reading the plan
 * has to work before that — otherwise "show me the numbers first" would force a
 * production DDL, which is exactly backwards. When the table is absent there is
 * by definition no prior restatement, so `original_unit_cost` is NULL for every
 * line and the LATERAL join is dropped.
 */
export async function hasAdjustmentTable(knex: KnexLike): Promise<boolean> {
  const { rows } = await knex.raw(`SELECT to_regclass('sale_cost_adjustment') IS NOT NULL AS present`);
  return Boolean((rows[0] as { present: boolean } | undefined)?.present);
}

/**
 * Strip the prior-restatement lookup out of a sale-line query. The join is
 * written as a self-contained LATERAL block so it can be removed textually
 * without disturbing the rest of the statement.
 */
function withoutAdjustmentJoin(sql: string): string {
  return sql
    .replace(
      /\s*LEFT JOIN LATERAL \(\s*SELECT a\.original_unit_cost[\s\S]*?\) adj ON true/g,
      ""
    )
    .replace(/adj\.original_unit_cost::text\s+AS original_unit_cost/g, "NULL::text AS original_unit_cost");
}

export async function loadScope(knex: KnexLike): Promise<ScopeVariantRow[]> {
  const { rows } = await knex.raw(SCOPE_SQL);
  return rows as ScopeVariantRow[];
}

export async function loadCostChanges(knex: KnexLike, cutoff: Date): Promise<CostChangeRow[]> {
  const { rows } = await knex.raw(COST_CHANGES_SQL, [cutoff.toISOString()]);
  return rows as CostChangeRow[];
}

export async function loadInvoiceLines(
  knex: KnexLike,
  cutoff: Date,
  adjustmentTableExists: boolean
): Promise<SaleLineRow[]> {
  const sql = adjustmentTableExists ? INVOICE_LINES_SQL : withoutAdjustmentJoin(INVOICE_LINES_SQL);
  const { rows } = await knex.raw(sql, [cutoff.toISOString()]);
  return rows as SaleLineRow[];
}

export async function loadCreditMemoLines(
  knex: KnexLike,
  cutoff: Date,
  adjustmentTableExists: boolean
): Promise<SaleLineRow[]> {
  const sql = adjustmentTableExists
    ? CREDIT_MEMO_LINES_SQL
    : withoutAdjustmentJoin(CREDIT_MEMO_LINES_SQL);
  const { rows } = await knex.raw(sql, [cutoff.toISOString()]);
  return rows as SaleLineRow[];
}
