/**
 * src/lib/cost/recost-window.ts
 *
 * Reprice the sales that happened between goods ARRIVING and their vendor bill
 * being CONFIRMED.
 *
 * THE GAP THIS CLOSES
 * A container lands on the 5th and its bill is confirmed on the 11th. The
 * confirm recomputes the moving average — but every sale in those six days was
 * already invoiced, and `pos_invoice_item.average_unit_cost` is frozen at sale
 * time, so those lines keep a cost that belonged to units bought earlier. The
 * goods that actually went out the door were from the new shipment.
 *
 * In production this window averaged 6.4 days (max 20) and had left 224 invoice
 * lines / 530 units mispriced. The one-off restatement cleaned the history, but
 * without this the very next late confirmation opens a fresh window — the same
 * drift, forever.
 *
 * Cost attaches to inventory when control of the goods is obtained; the invoice
 * that arrives later only reveals the amount. So the new average is effective
 * from `received_at`, and the sales after that instant belong to it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  - It never touches a line priced BEFORE the goods arrived. Those units came
 *    from the previous shipment and their cost is correct.
 *  - A credit-memo line is repriced only when the invoice line it reverses was
 *    repriced in this same pass. A return sends specific units back; reversing
 *    them at anything other than what they were issued at fabricates a gain.
 *  - It never writes a cost of zero or less.
 *
 * Every change lands in `sale_cost_adjustment` and every write is
 * compare-and-swap, exactly like the restatement.
 */

export interface RecostKnex {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
  transaction: <T>(handler: (trx: any) => Promise<T>) => Promise<T>;
}

export interface RecostWindowInput {
  /**
   * The cost THIS event established, per variant, in dollars — not whatever the
   * variant carries right now.
   *
   * Reading the current `average_cost` instead looks equivalent and is not: for
   * any variant with more than one bill, today's average already includes the
   * LATER bills, so repricing an earlier window with it would price those sales
   * at a cost that did not exist yet. A dry run over production's history moved
   * 262 lines that were already correct, which is how this surfaced.
   */
  costByVariant: ReadonlyMap<string, number>;
  /** Start of the window: when the goods physically arrived. */
  from: Date;
  /**
   * End of the window, exclusive. Defaults to the next cost event for each
   * variant, so one bill's pass can never reach into the next bill's window.
   * Left open only when there is no later event.
   */
  until?: Date;
  /** Deterministic id so a retry reuses rows instead of stacking corrections. */
  runId: string;
  reason: string;
  /** Compute and report without writing. */
  dryRun?: boolean;
}

export interface RecostWindowResult {
  invoiceLinesRepriced: number;
  creditMemoLinesRepriced: number;
  cogsDeltaCents: number;
  /** Lines found in the window whose cost already matched — nothing to do. */
  alreadyCorrect: number;
  details: Array<{
    sourceType: "invoice_item" | "credit_memo_item";
    lineId: string;
    sku: string | null;
    quantity: number;
    fromCost: number | null;
    toCost: number;
  }>;
}

interface WindowLine {
  source_type: "invoice_item" | "credit_memo_item";
  line_id: string;
  document_id: string;
  variant_id: string;
  sku: string | null;
  quantity: number | string;
  current_cost: string | null;
  new_cost: string;
  economic_posted_at: string | Date;
  parent_invoice_line_id: string | null;
}

/**
 * Invoice lines in the window, plus the credit-memo lines that reverse them.
 *
 * `new_cost` is the variant's CURRENT `average_cost` — the value the confirm
 * just wrote. The caller must run this AFTER persisting the new average.
 */
const WINDOW_SQL = `
WITH input AS (
  SELECT * FROM UNNEST(?::text[], ?::numeric[]) AS u(variant_id, new_cost)
),
target AS (
  SELECT pv.id, pv.sku, i.new_cost,
         -- Window end: the variant's next cost event after the one being
         -- processed. Without it, an early bill's pass would reach forward over
         -- every later bill's window and undo them.
         --
         -- Read from variant_cost_event, the reconstructed timeline, never from
         -- vendor_bill_cost_log, whose stored averages are the output of the
         -- bug the restatement replaced. (No backticks in SQL comments: inside
         -- a JS template literal they close the string.)
         COALESCE(
           ?::timestamptz,
           (SELECT MIN(e2.effective_at)
              FROM variant_cost_event e2
             WHERE e2.product_variant_id = pv.id
               AND e2.status = 'active'
               AND e2.cost_field = 'average_cost'
               AND e2.effective_at > ?::timestamptz),
           'infinity'::timestamptz
         ) AS window_end
    FROM product_variant pv
    JOIN input i ON i.variant_id = pv.id
   WHERE pv.deleted_at IS NULL AND i.new_cost > 0
),
invoice_lines AS (
  SELECT 'invoice_item'::text AS source_type, ii.id AS line_id, i.id AS document_id,
         t.id AS variant_id, ii.sku, ii.quantity,
         ii.average_unit_cost::text AS current_cost, t.new_cost::text AS new_cost,
         COALESCE(i.issued_at, i.created_at) AS economic_posted_at,
         NULL::text AS parent_invoice_line_id
    FROM pos_invoice_item ii
    JOIN pos_invoice i ON i.id = ii.invoice_id
    JOIN target t ON t.sku = ii.sku
   WHERE ii.deleted_at IS NULL AND i.deleted_at IS NULL AND i.voided_at IS NULL
     AND ii.quantity <> 0
     AND COALESCE(i.issued_at, i.created_at) >= ?::timestamptz
     AND COALESCE(i.issued_at, i.created_at) < t.window_end
)
SELECT * FROM invoice_lines
UNION ALL
-- Returns follow their sale: only memo lines whose parent invoice line is being
-- repriced above, and they take that same cost.
SELECT 'credit_memo_item', cmi.id, cm.id, t.id, cmi.sku, cmi.quantity,
       cmi.average_unit_cost::text, t.new_cost::text,
       COALESCE(cm.completed_at, cm.created_at),
       parent.line_id
  FROM pos_credit_memo_item cmi
  JOIN pos_credit_memo cm ON cm.id = cmi.credit_memo_id
  JOIN target t ON t.sku = cmi.sku
  JOIN invoice_lines parent
    ON parent.document_id = cm.invoice_id AND parent.sku = cmi.sku
 WHERE cmi.deleted_at IS NULL AND cm.deleted_at IS NULL AND cm.voided_at IS NULL
   AND cmi.quantity <> 0
`;

const num = (raw: unknown): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};
const parse = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};
const iso = (raw: unknown): string =>
  raw instanceof Date ? raw.toISOString() : String(raw ?? "");

/** Stable id so a retried pass reuses the row instead of duplicating it. */
function adjustmentId(runId: string, sourceType: string, lineId: string): string {
  let hash = 0x811c9dc5;
  const input = `${runId}:${sourceType}:${lineId}`;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(hash ^ input.charCodeAt(i), 0x01000193) >>> 0;
  }
  return `sca_rw_${hash.toString(36)}${lineId.slice(-6)}`;
}

const COST_EPSILON = 0.000_05;

export async function recostSalesWindow(
  knex: RecostKnex,
  input: RecostWindowInput
): Promise<RecostWindowResult> {
  const empty: RecostWindowResult = {
    invoiceLinesRepriced: 0,
    creditMemoLinesRepriced: 0,
    cogsDeltaCents: 0,
    alreadyCorrect: 0,
    details: [],
  };
  const entries = [...input.costByVariant.entries()].filter(([, cost]) => cost > 0);
  if (entries.length === 0) return empty;

  const { rows } = await knex.raw(WINDOW_SQL, [
    entries.map(([variantId]) => variantId),
    entries.map(([, cost]) => cost),
    input.until ? input.until.toISOString() : null,
    input.from.toISOString(),
    input.from.toISOString(),
  ]);
  const lines = rows as WindowLine[];
  if (lines.length === 0) return empty;

  const changes = lines.filter((line) => {
    const current = parse(line.current_cost);
    const next = parse(line.new_cost);
    if (next === null || next <= 0) return false;
    return current === null || Math.abs(current - next) > COST_EPSILON;
  });
  const alreadyCorrect = lines.length - changes.length;
  if (changes.length === 0) return { ...empty, alreadyCorrect };

  const result: RecostWindowResult = {
    invoiceLinesRepriced: changes.filter((l) => l.source_type === "invoice_item").length,
    creditMemoLinesRepriced: changes.filter((l) => l.source_type === "credit_memo_item").length,
    cogsDeltaCents: Math.round(
      changes.reduce((sum, line) => {
        const delta = (num(line.new_cost) - (parse(line.current_cost) ?? 0)) * num(line.quantity);
        // A return reverses COGS, so its movement is the opposite sign.
        return sum + (line.source_type === "credit_memo_item" ? -delta : delta) * 100;
      }, 0)
    ),
    alreadyCorrect,
    details: changes.map((line) => ({
      sourceType: line.source_type,
      lineId: line.line_id,
      sku: line.sku,
      quantity: num(line.quantity),
      fromCost: parse(line.current_cost),
      toCost: num(line.new_cost),
    })),
  };

  if (input.dryRun) return result;

  await knex.transaction(async (trx) => {
    // Audit first: the pre-repricing value survives even if an update fails.
    await trx.raw(
      `INSERT INTO sale_cost_adjustment
         (id, restatement_run_id, source_type, source_line_id, source_document_id,
          product_variant_id, sku, quantity, original_unit_cost, prior_restated_unit_cost,
          new_restated_unit_cost, original_extended_cogs, new_extended_cogs, delta_cogs,
          economic_posted_at, reason_code, derived_from_line_id)
       SELECT u.id, ?, u.source_type, u.line_id, u.document_id, u.variant_id, u.sku,
              u.quantity,
              COALESCE(prior.original_unit_cost, u.current_cost),
              u.current_cost, u.new_cost,
              u.current_cost * u.quantity, u.new_cost * u.quantity,
              (u.new_cost - COALESCE(u.current_cost, 0)) * u.quantity,
              u.posted_at::timestamptz, ?, u.parent_line_id
         FROM UNNEST(?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[],
                     ?::int[], ?::numeric[], ?::numeric[], ?::text[], ?::text[])
              AS u(id, source_type, line_id, document_id, variant_id, sku,
                   quantity, current_cost, new_cost, posted_at, parent_line_id)
         LEFT JOIN LATERAL (
           SELECT a.original_unit_cost FROM sale_cost_adjustment a
            WHERE a.source_type = u.source_type AND a.source_line_id = u.line_id
            ORDER BY a.created_at ASC LIMIT 1
         ) prior ON true
       ON CONFLICT (restatement_run_id, source_type, source_line_id) DO NOTHING`,
      [
        input.runId,
        input.reason,
        changes.map((l) => adjustmentId(input.runId, l.source_type, l.line_id)),
        changes.map((l) => l.source_type),
        changes.map((l) => l.line_id),
        changes.map((l) => l.document_id),
        changes.map((l) => l.variant_id),
        changes.map((l) => l.sku),
        changes.map((l) => num(l.quantity)),
        changes.map((l) => parse(l.current_cost)),
        changes.map((l) => num(l.new_cost)),
        changes.map((l) => iso(l.economic_posted_at)),
        changes.map((l) => l.parent_invoice_line_id),
      ]
    );

    for (const table of ["pos_invoice_item", "pos_credit_memo_item"] as const) {
      const sourceType = table === "pos_invoice_item" ? "invoice_item" : "credit_memo_item";
      const group = changes.filter((line) => line.source_type === sourceType);
      if (group.length === 0) continue;

      const update = await trx.raw(
        `UPDATE ${table} AS t
            SET average_unit_cost = u.new_cost,
                raw_average_unit_cost = jsonb_build_object('value', u.new_cost),
                average_unit_cost_synced_at = NOW(),
                updated_at = NOW()
           FROM UNNEST(?::text[], ?::numeric[], ?::numeric[])
                AS u(line_id, new_cost, expected_cost)
          WHERE t.id = u.line_id
            AND t.deleted_at IS NULL
            AND t.average_unit_cost IS NOT DISTINCT FROM u.expected_cost`,
        [
          group.map((l) => l.line_id),
          group.map((l) => num(l.new_cost)),
          group.map((l) => parse(l.current_cost)),
        ]
      );

      const applied = update.rowCount ?? 0;
      if (applied !== group.length) {
        throw new Error(
          `recost-window ${table}: expected ${group.length} rows, matched ${applied}. ` +
            `A line's cost changed underneath the pass — rolling back.`
        );
      }
    }
  });

  return result;
}
