/**
 * The one place that rewrites an order's tax lines, and the one place that
 * derives the order total that gets patched into `order_summary`.
 *
 * Both used to be copy-pasted into three POS edit routes (post-edit-sync,
 * apply-discount-force, convert-force), and both were wrong in the same way in
 * all three.
 *
 * ── What QuickBooks actually does (measured, not assumed) ────────────────────
 * Verified against two live documents via the bridge:
 *
 *   SR 27807  (S10013, one taxable line)
 *     Subtotal 99.98 · SalesTaxTotal 7.00 · TotalAmount 106.98
 *   Invoice 18861 (S10732, taxable + exempt + shipping)
 *     Subtotal 148.99 · SalesTaxTotal 5.25 · TotalAmount 154.24
 *     lines: product → Tax · Services → Non · SHIPPING → Non
 *
 * So QB rounds the tax ONCE over the aggregate of the taxable lines, and it
 * honours a per-line Non. `pos_invoice` already agrees with QB to the cent in
 * both. The layer that disagreed was `order_summary`, and it is the layer the
 * /orders list reads — which is why the totals only ever looked wrong in the
 * list and never when you opened the order.
 *
 * ── The two defects this module replaces ─────────────────────────────────────
 * 1. The tax lines were inserted at ONE rate for EVERY line of the order, with
 *    no per-line `taxable` check. On a mixed order that taxes the exempt line:
 *    S10732 came out at 156.6193 against QuickBooks' 154.24 — $2.38 of tax on a
 *    $34.00 service that is exempt on both sides of the bridge.
 * 2. The patched total was `original_order_total + pos_tax − discount`, but
 *    `original_order_total` ALREADY carries Medusa's native tax. Measured on 43
 *    orders as a dead-constant ratio of 6.535–6.563% — which is 7/107, the
 *    signature of a tax added twice. Seven more orders looked correct only
 *    because their `original_order_total` happened to carry no native tax; for
 *    those the ratio is exactly 7.000%. Subtracting the embedded native tax
 *    repairs the first group and leaves the second bit-identical.
 */

/** Anything with a `.query($1-style)` — a pg Pool, or a client inside a tx. */
export type SqlRunner = {
  query: <T = any>(
    sql: string,
    params?: any[]
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

export type TaxLineRewrite = {
  itemIds: string[];
  taxedItemIds: string[];
  exemptItemIds: string[];
};

const FL_CODE = "FL";
const FL_DESC = "Florida Sales Tax";
const EXEMPT_CODE = "EXEMPT";
const EXEMPT_DESC = "Tax Exempt";

function genTaxLineId(): string {
  return `taxline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Deletes and re-creates the tax lines for every live line of an order,
 * honouring each line's own `taxable` flag.
 *
 * Taxability is a PRODUCT attribute. There is no way to change it per line from
 * the POS — the only screen that writes the flag is the catalog item editor
 * (`inventory/CreateItemModalV2`), and no orders/draft-orders route accepts
 * `taxable` in a line body. `order_line_item.taxable` is therefore not an
 * order-specific decision: it is a SNAPSHOT that the DB trigger
 * `set_order_line_item_taxable_from_product` seeds from `product.taxable` when
 * the line is created, so a past document keeps the taxability that applied at
 * the time rather than following later catalog edits.
 *
 * A line is treated as exempt when EITHER the snapshot or the product says so.
 * The two can disagree: 8 lines created before the trigger existed (2026-04-16
 * to 2026-05-02; the migration is 1778000000000, ~2026-05-05) still carry the
 * column default `true` under a product marked non-taxable. Taking either one
 * alone makes this module disagree with the QuickBooks payload, which already
 * combines them the same way — and disagreeing about one line is how the same
 * order gets two different tax figures.
 *
 * `effectiveRate` of 0 makes every line exempt, which is the tax-exempt-customer
 * case and stays as it was.
 */
export async function replaceOrderTaxLines(
  runner: SqlRunner,
  orderId: string,
  effectiveRate: number
): Promise<TaxLineRewrite> {
  const res = await runner.query<{
    item_id: string;
    taxable: boolean | null;
    existing_rate: string | number | null;
    existing_raw_rate: any;
    existing_code: string | null;
    existing_desc: string | null;
    existing_count: string | number | null;
  }>(
    // LINE flag only — deliberately, and against the theory.
    //
    // Combining it with product.taxable looks more correct on paper (the QB
    // payload builder does exactly that), but it was measured against the two
    // things that actually decide: the POS screen and a real QuickBooks
    // document. Order S10255 shows Tax $240.88 on screen, taxing its $750
    // Services line whose PRODUCT is non-taxable but whose LINE says taxable —
    // and QuickBooks billed $240.91 on Invoice 19473, three cents away. The
    // combined predicate produces $188.41, off by $52.50 from both.
    //
    // So the line flag is what the screen and the ledger agree on. Consult the
    // product here and the list stops matching the order you opened.
    `SELECT DISTINCT oi.item_id,
            COALESCE(li.taxable, true) AS taxable,
            (SELECT t.rate FROM order_line_item_tax_line t
              WHERE t.item_id = oi.item_id AND t.deleted_at IS NULL
              LIMIT 1) AS existing_rate,
            (SELECT t.raw_rate FROM order_line_item_tax_line t
              WHERE t.item_id = oi.item_id AND t.deleted_at IS NULL
              LIMIT 1) AS existing_raw_rate,
            (SELECT t.code FROM order_line_item_tax_line t
              WHERE t.item_id = oi.item_id AND t.deleted_at IS NULL
              LIMIT 1) AS existing_code,
            (SELECT t.description FROM order_line_item_tax_line t
              WHERE t.item_id = oi.item_id AND t.deleted_at IS NULL
              LIMIT 1) AS existing_desc,
            (SELECT count(*) FROM order_line_item_tax_line t
              WHERE t.item_id = oi.item_id AND t.deleted_at IS NULL) AS existing_count
       FROM order_item oi
       JOIN order_line_item li ON li.id = oi.item_id
      WHERE oi.order_id = $1 AND oi.deleted_at IS NULL`,
    [orderId]
  );

  const itemIds = res.rows.map((r) => r.item_id);
  const empty: TaxLineRewrite = {
    itemIds: [],
    taxedItemIds: [],
    exemptItemIds: [],
  };
  if (itemIds.length === 0) return empty;

  // NULL taxable means "no opinion" → taxable, matching the DB default.
  const wanted = res.rows.map((r) => {
    const lineExempt = r.taxable === false || effectiveRate === 0;
    return {
      itemId: r.item_id,
      exempt: lineExempt,
      rate: lineExempt ? 0 : effectiveRate,
      code: lineExempt ? EXEMPT_CODE : FL_CODE,
      desc: lineExempt ? EXEMPT_DESC : FL_DESC,
      // Compare the WHOLE stored shape, not just rate and code.
      //
      // `raw_rate` matters as much as `rate`: Medusa reads its money and
      // BigNumber fields from the `raw_*` JSONB, not from the numeric column, so
      // a row with rate=7 and a stale raw_rate of 0 computes zero tax while
      // looking perfectly correct to a rate-only comparison — and the no-op
      // would skip it, leaving the bad value in place forever.
      unchanged:
        Number(r.existing_count ?? 0) === 1 &&
        Number(r.existing_rate) === (lineExempt ? 0 : effectiveRate) &&
        Number(
          (r.existing_raw_rate &&
            (typeof r.existing_raw_rate === "string"
              ? JSON.parse(r.existing_raw_rate)
              : r.existing_raw_rate)?.value) ?? NaN
        ) === (lineExempt ? 0 : effectiveRate) &&
        r.existing_code === (lineExempt ? EXEMPT_CODE : FL_CODE) &&
        r.existing_desc === (lineExempt ? EXEMPT_DESC : FL_DESC),
    };
  });

  const taxedItemIds = wanted.filter((w) => !w.exempt).map((w) => w.itemId);
  const exemptItemIds = wanted.filter((w) => w.exempt).map((w) => w.itemId);

  // Strict no-op. When every line already carries exactly the tax line it
  // should, touching nothing is not an optimisation — it is the difference
  // between "this change does not move an order that was already right" and
  // "every order gets new tax-line ids and timestamps for no reason".
  if (wanted.every((w) => w.unchanged)) {
    return { itemIds, taxedItemIds, exemptItemIds };
  }

  // Atomic. DELETE followed by N separate INSERTs on a Pool can land on
  // different connections, each auto-committing on its own, so a failure
  // halfway leaves the order with SOME of its tax lines — Medusa then computes
  // a partial tax and, worse, `tax_total = 0` would flip the QuickBooks header
  // to Exempt. One transaction, one multi-row INSERT.
  const values: any[] = [];
  const tuples = wanted.map((w, i) => {
    const b = i * 6;
    values.push(
      genTaxLineId(),
      w.itemId,
      w.code,
      w.rate,
      JSON.stringify({ value: String(w.rate), precision: 20 }),
      w.desc
    );
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, NOW(), NOW())`;
  });

  const runInTx = async (r: SqlRunner) => {
    await r.query(
      `DELETE FROM order_line_item_tax_line WHERE item_id = ANY($1)`,
      [itemIds]
    );
    await r.query(
      `INSERT INTO order_line_item_tax_line
         (id, item_id, code, rate, raw_rate, description, created_at, updated_at)
       VALUES ${tuples.join(", ")}`,
      values
    );
  };

  // Discriminate on `release`, NOT on `connect`. A pg PoolClient has BOTH, so
  // testing for `connect` classifies an already-checked-out client as a pool
  // and calling connect() on it throws "Client has already been connected" —
  // which convert-force then swallowed as a soft failure, leaving the tax lines
  // unwritten and the summary unpatched with nothing but a warning to show for
  // it. Only a PoolClient carries `release`.
  const maybe = runner as SqlRunner & {
    connect?: () => Promise<any>;
    release?: () => void;
  };
  const isCheckedOutClient = typeof maybe.release === "function";
  if (!isCheckedOutClient && typeof maybe.connect === "function") {
    // A Pool: own the transaction here.
    const client = await maybe.connect!();
    try {
      await client.query("BEGIN");
      await runInTx(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } else {
    // Already a checked-out client inside the caller's transaction.
    await runInTx(runner);
  }

  return { itemIds, taxedItemIds, exemptItemIds };
}

/**
 * order_line_item.id → taxable, for the lines of one order.
 *
 * Needed because MikroORM strips this custom column from the payloads the API
 * hands back, so a route holding `order.items` cannot see it and will silently
 * treat every line as taxable. Absent id ⇒ caller should assume taxable.
 */
export async function loadLineTaxability(
  runner: SqlRunner,
  orderId: string
): Promise<Record<string, boolean>> {
  // Deliberately NOT wrapped in a catch that returns {}. An empty map is
  // indistinguishable from "every line is taxable", so swallowing the error
  // here silently taxes exempt lines — which is exactly what happened the first
  // time this ran against the sandbox: the pool it was handed could not open an
  // SSL connection, the catch ate it, and the tax came back charged on all
  // $2580 instead of the $2250 that is taxable. The caller must decide what to
  // do when taxability is unknown; it must never be told "all taxable" by
  // accident.
  const res = await runner.query<{ item_id: string; taxable: boolean | null }>(
    // LINE flag only, matching the POS screen (see replaceOrderTaxLines).
    `SELECT DISTINCT oi.item_id,
            COALESCE(li.taxable, true) AS taxable
       FROM order_item oi
       JOIN order_line_item li ON li.id = oi.item_id
      WHERE oi.order_id = $1 AND oi.deleted_at IS NULL`,
    [orderId]
  );
  return Object.fromEntries(
    res.rows.map((r) => [r.item_id, r.taxable !== false])
  );
}

export type OrderMoneyBase = {
  /** Σ line (unit_price × qty − line adjustments), in dollars. */
  netDollars: number;
  /** Σ line net for lines whose own `taxable` flag is not false. */
  taxableNetDollars: number;
  shippingDollars: number;
  /**
   * Σ of the line adjustments ALREADY subtracted from `netDollars`.
   *
   * Load-bearing, not informational. Medusa distributes an ORDER-level discount
   * into per-line adjustments — measured in production: every discounted order
   * has `order_summary.totals.discount_total` NULL while its line adjustments
   * sum to the discount (S11284 → 2237.625, S11179 → 17680.32). Meanwhile
   * `post-edit-sync` receives that same discount again as `pos_discount_amount`.
   * Subtracting both is a double discount: a $200 order with $20 off and $12.60
   * of tax would store $172.60 instead of $192.60, understating the total and,
   * through `order_money_projection`, clamping a legitimate deposit.
   */
  adjustmentsDollars: number;
  /**
   * The per-line discount ALREADY baked into `unit_price`, i.e.
   * Σ (original_unit_price − unit_price) × qty.
   *
   * Needed for the same reason as `adjustmentsDollars`: to know whether the
   * caller's discount figure is a NEW deduction or one the base already
   * carries. A discount can be represented three ways in this system — baked
   * into the price, held in an adjustment row, or merely announced by the
   * caller — and subtracting one that is already inside the base charges the
   * customer's discount twice.
   */
  bakedDiscountDollars: number;
};

/**
 * Reads an order's money base from its own lines.
 *
 * This exists because deriving the total by arithmetic on
 * `original_order_total` is not safe: that field sometimes carries the native
 * tax and sometimes does not. Measured both ways — order S10013 in production
 * stored 106.9786 (99.98 net + 6.9986 tax) while a freshly converted draft in
 * the sandbox stored 2580.00 with its 157.50 of tax held separately. Any
 * formula that assumes one of those shapes silently corrupts the other, which
 * is how "subtract the embedded tax" produced a total with NO tax at all.
 *
 * So: read the components, add them up. `unit_price`, `amount` and the
 * adjustment amounts are all dollars on these tables.
 */
export async function loadOrderMoneyBase(
  runner: SqlRunner,
  orderId: string
): Promise<OrderMoneyBase> {
  const lines = await runner.query<{
    taxable: boolean | null;
    unit_price: string | number | null;
    original_unit_price: string | number | null;
    quantity: string | number | null;
    adj: string | number | null;
  }>(
    // Both joins are version-scoped, and neither is optional.
    //
    // `order_item` keeps a row per order version, so an unfiltered join counts
    // every line once per version — order S10275 has 37 of them.
    //
    // `order_line_item_adjustment` is versioned too: Medusa RE-CREATES the
    // adjustment rows on every edit rather than updating them, so a line with
    // one 12.5% discount edited twice holds three live rows (versions 35, 36,
    // 37) and summing them charges 37.5%. They are history, not duplicates.
    // The de-dup convention is the repo's existing one from
    // `api/admin/reports/_lib/item-discount.ts`: newest version per (item, code).
    `SELECT COALESCE(li.taxable, true) AS taxable,
            li.unit_price,
            NULLIF(li.metadata->>'original_unit_price','')::numeric AS original_unit_price,
            oi.quantity,
            COALESCE((
              SELECT SUM(ABS(latest.amount))
                FROM (
                  SELECT DISTINCT ON (a.code) a.amount
                    FROM order_line_item_adjustment a
                   WHERE a.item_id = li.id AND a.deleted_at IS NULL
                   ORDER BY a.code, a.version DESC
                ) latest
            ), 0) AS adj
       FROM order_item oi
       JOIN order_line_item li ON li.id = oi.item_id
      WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
        AND oi.version = (SELECT o.version FROM "order" o WHERE o.id = $1)`,
    [orderId]
  );

  // Integer cents, and the SAME rounding convention the POS uses: BOTH the
  // gross and the discount are rounded PER LINE, then summed.
  //
  // The discount used to be accumulated unrounded and rounded once at the end.
  // That is the convention QuickBooks uses for the TAX, so it looked right by
  // analogy — but the discount does not reach QuickBooks the way the tax does.
  // `buildQbOrderDiscountLines` sends an "exact dollar amount so QB doesn't
  // recalculate via %", and that amount comes from the POS, which rounds each
  // line to the cent (`computeTotals`, store-pos/lib/pos-totals.ts). So the
  // customer's printed document and the QuickBooks document both carry the
  // per-line figure, and only the stored order total carried the aggregate one.
  //
  // Measured on order 2811 / S11242 (QB Invoice 19614, read back over the
  // bridge): per-line 138.07 → total 1699.07, which is what `pos_invoice` holds
  // AND what QuickBooks billed. The aggregate gave 138.08 → 1699.06, one cent
  // under the paper the customer is holding. 7 of the 31 discounted orders in
  // production differ between the two, by 1¢ to 4¢.
  let grossCents = 0;
  let taxableGrossCents = 0;
  let adjCents = 0;
  let taxableAdjCents = 0;
  let bakedCents = 0;

  for (const row of lines.rows) {
    // NET (`unit_price`), which already carries any per-line discount. The
    // pre-discount price in `metadata.original_unit_price` is NOT the base.
    //
    // Using the gross looked right on S10255, where the per-line discount and
    // the QB trailing Discount line were the SAME 10% — subtracting the order
    // discount from the gross landed on QB's figure and closed a 45c rounding
    // gap. It is catastrophically wrong anywhere the two are DIFFERENT
    // discounts: 7 orders / 147 lines carry a real per-line discount baked into
    // the price AND a separate order-level discount in the adjustments, and
    // taking the gross while subtracting only the adjustments never subtracts
    // the per-line one. Measured overstatement: E2606 +$1,338.40, E2607
    // +$753.59, E1344 +$92.20.
    //
    // The data says which is which — the line carries
    // `metadata.line_discount {type,value}` and the adjustment carries a code
    // like `ORDER-DISCOUNT-25%` — so the net already has the per-line layer
    // applied and the adjustments are the order layer. NET minus adjustments
    // reproduces the POS to the cent on all three (2098.76 / 3036.83 / 7521.62).
    //
    // S10255's 45c is not a counterexample: that order predates the
    // `computed_*` metadata and its invoice was assembled differently.
    const unit = Number(row.unit_price ?? 0);
    const netUnit = unit;
    const qty = Number(row.quantity ?? 0);
    const adj = Number(row.adj ?? 0);
    // A non-finite line is NOT skipped. Skipping silently turns a $500 line into
    // a $0 contribution, which is how a stored total collapses to ~$0 against a
    // real order value — the exact shape of the six orders this change guards.
    if (!Number.isFinite(unit) || !Number.isFinite(qty) || !Number.isFinite(adj) || !Number.isFinite(netUnit)) {
      throw new Error(
        `order ${orderId} has a line with a non-finite price, quantity or adjustment; refusing to derive a total from it`
      );
    }
    // Round the LINE, not the unit. A percentage line discount can leave a
    // unit price with four decimals (E1497: 33.808, 250.49214…) and the two
    // orders of operation then disagree:
    //   round(33.808 * 100) * 65 = 219765   ← per unit
    //   round(33.808 * 65 * 100) = 219752   ← per line
    //
    // Settled by asking QUICKBOOKS, which is the only authority here: the
    // customer already holds the document QB issued. Read back over the bridge,
    // QB's own Subtotal is the per-line figure on both extremes of the 17 orders
    // where the rules differ — E1497 30097.89 (per-unit says 30097.30) and
    // E1976 4513.29 (per-unit says 4513.51).
    //
    // This code was briefly flipped to per-unit because that form reproduces
    // more of the `computed_subtotal` values the POS stored (438 of 462, against
    // 422). That was measuring the wrong authority: on exactly these 17 orders
    // the POS snapshot is what disagrees with QB, so counting agreements with it
    // optimises for reproducing our own error. Fewer mismatches is not the goal;
    // matching the document the customer was given is.
    //
    // For a price already at two decimals the two are identical.
    const lineGross = Math.round(unit * qty * 100);
    // Rounded HERE, per line — see the note above the accumulators.
    const lineAdj = Math.round(adj * 100);
    // How much the per-line discount already took off this line, if any.
    const originalUnit = Number(row.original_unit_price ?? 0);
    if (originalUnit > unit) {
      bakedCents += (Math.round(originalUnit * 100) - Math.round(unit * 100)) * qty;
    }
    grossCents += lineGross;
    adjCents += lineAdj;
    if (row.taxable !== false) {
      taxableGrossCents += lineGross;
      taxableAdjCents += lineAdj;
    }
  }

  const netCents = Math.max(0, grossCents - adjCents);
  const taxableNetCents = Math.max(0, taxableGrossCents - taxableAdjCents);
  const netDollars = netCents / 100;
  const taxableNetDollars = taxableNetCents / 100;
  const adjustmentsDollars = adjCents / 100;
  const bakedDiscountDollars = bakedCents / 100;

  const ship = await runner.query<{ s: string | number | null }>(
    // `order_shipping` is versioned too — the THIRD table in this query with
    // that trap, after `order_item` and `order_line_item_adjustment`. Order
    // S10287 keeps 19 shipping rows across its 20 versions, 5 of them at $40,
    // so an unscoped SUM reports $200 of shipping on a $40 delivery and the
    // stored total lands $160 high.
    `SELECT COALESCE(SUM(sm.amount), 0) AS s
       FROM order_shipping os
       JOIN order_shipping_method sm ON sm.id = os.shipping_method_id
      WHERE os.order_id = $1 AND os.deleted_at IS NULL
        AND os.version = (SELECT o.version FROM "order" o WHERE o.id = $1)`,
    [orderId]
  );

  return {
    netDollars: round2(netDollars),
    taxableNetDollars: round2(taxableNetDollars),
    shippingDollars: round2(Number(ship.rows[0]?.s ?? 0)),
    adjustmentsDollars: round2(adjustmentsDollars),
    bakedDiscountDollars: round2(bakedDiscountDollars),
  };
}

/**
 * The QuickBooks-parity tax: the rate applied to the taxable aggregate and
 * rounded ONCE, at the document level.
 *
 * Medusa accumulates per line and leaves the decimals hanging (99.98 @ 7% →
 * 6.9986); QuickBooks billed 7.00 on that very order. Because
 * Σ(lineᵢ × rate) === (Σ lineᵢ) × rate, rounding the aggregate once lands on
 * QB's figure exactly.
 */
export function computeQbParityTax(
  taxableNetDollars: number,
  ratePercent: number
): number {
  return round2(taxableNetDollars * (ratePercent / 100));
}

/**
 * The taxable base and the QB-parity tax for an order, from its own lines.
 *
 * One derivation, used by every caller, because two of them had drifted apart:
 * `compute-tax` built its base from the API's NET unit prices while the money
 * base reads the GROSS from `metadata.original_unit_price`, so the same order
 * produced two different taxable amounts depending on which route you asked.
 *
 * The order-level discount reduces the taxable base — QuickBooks codes its
 * `Discount` line `Tax` (verified on Invoice 19473, where the -299.08 sits right
 * after the taxable products' Subtotal and QB billed 240.91 on 3441.55, not on
 * 3740.63). Only the part of the discount that is not already inside the line
 * adjustments is subtracted, or it comes off twice.
 */
export function resolveQbParityTax(
  base: OrderMoneyBase,
  discount: number,
  ratePercent: number
): { taxableBase: number; tax: number } {
  const representedCents =
    toCents(base.adjustmentsDollars) + toCents(base.bakedDiscountDollars);
  const residualCents = Math.max(0, toCents(discount) - representedCents);
  const taxableCents = Math.max(
    0,
    toCents(base.taxableNetDollars) - residualCents
  );
  const taxableBase = taxableCents / 100;
  return { taxableBase, tax: computeQbParityTax(taxableBase, ratePercent) };
}

export type PatchedTotalInput = {
  /**
   * The order's own money base, read from its lines. NOT
   * `original_order_total` — that field carries the native tax on some orders
   * and not on others, so any arithmetic on it corrupts one shape or the other.
   */
  base: OrderMoneyBase;
  /** The POS/QuickBooks-parity tax: rounded once over the taxable aggregate. */
  posTaxAmount: number;
  /** Order-level discount to subtract (line-level discounts are already in the base). */
  discount: number;
};

export type PatchedTotalResult =
  | { ok: true; total: number; preTaxBase: number; warnings: string[] }
  | { ok: false; reason: string };

/**
 * Derives the total to patch into `order_summary`, or refuses.
 *
 * Refusing matters more than it looks. The old code silently defaulted an
 * unreadable native tax to 0, and a 0 here is indistinguishable from "this
 * order genuinely has no native tax" — one of those double-counts the tax and
 * the other is correct. Writing a total we cannot stand behind is worse than
 * leaving the previous one: this figure is the clamp ceiling for
 * `order_money_projection`, so a bad total silently zeroes a real deposit.
 */
export function resolvePatchedOrderTotal(
  input: PatchedTotalInput
): PatchedTotalResult {
  const { base, posTaxAmount, discount } = input;
  const warnings: string[] = [];

  if (
    !Number.isFinite(base.netDollars) ||
    !Number.isFinite(base.shippingDollars) ||
    !Number.isFinite(posTaxAmount)
  ) {
    return { ok: false, reason: "non-finite base or tax input" };
  }
  if (base.netDollars < 0) {
    return { ok: false, reason: `negative line net ${base.netDollars}` };
  }

  // Integer cents from here on. `Math.round((n + EPSILON) * 100) / 100` is not
  // a correct money rounder — EPSILON is relative to 1, so it does not correct
  // the binary error at other magnitudes (round2(10.075) returns 10.07, and
  // round2(-1.005) returns -1). Converting once at the boundary and adding
  // integers afterwards keeps the error from compounding across the sum.
  const preTaxBaseCents =
    toCents(base.netDollars) + toCents(base.shippingDollars);
  const preTaxBase = preTaxBaseCents / 100;

  // Subtract only the part of the caller's discount that is NOT already inside
  // the base. Medusa distributes an order-level discount into per-line
  // adjustments, and `netDollars` has those subtracted already, so taking the
  // caller's figure at face value discounts the order twice. When the discount
  // is fully represented in the adjustments — the normal case in production —
  // the residual is zero and the base stands as read.
  // Subtract only what the base does NOT already carry. A discount reaches this
  // system three ways and the base already reflects the first two:
  //   • baked into `unit_price`   (S10255: $299.53 of a 10% per-line discount)
  //   • an adjustment row         (E2606: $15.99 order-level)
  //   • announced only by the caller, not yet materialised anywhere
  // Measuring the caller's figure against just the adjustments double-charged
  // the baked kind; measuring against just the baked kind would double-charge
  // the adjustment kind.
  const representedCents =
    toCents(base.adjustmentsDollars) + toCents(base.bakedDiscountDollars);
  const residualCents = Math.max(0, toCents(discount) - representedCents);
  const residualDiscount = residualCents / 100;
  if (discount > 0 && residualDiscount < discount) {
    warnings.push(
      `discount ${discount} is already represented in the base ` +
        `(baked ${base.bakedDiscountDollars} + adjustments ${base.adjustmentsDollars}); ` +
        `subtracting only the ${residualDiscount} residual`
    );
  }

  // A discount larger than everything it can apply to is the signature of the
  // six orders whose stored total collapsed to ~$0 against a real order value
  // (S10619: $500.23 → $0.00). Whatever produces it, an order is not worth a
  // negative amount, and writing 0 here poisons the deposit clamp downstream.
  const ceilingCents = preTaxBaseCents + toCents(posTaxAmount);
  const ceiling = ceilingCents / 100;
  if (residualDiscount > ceiling + 0.005) {
    return {
      ok: false,
      reason: `discount ${residualDiscount} exceeds the order's own value ${ceiling}`,
    };
  }

  const total = (ceilingCents - residualCents) / 100;
  if (total <= 0 && ceiling > 0) {
    warnings.push(
      `total resolves to ${total} on an order worth ${ceiling} before discount`
    );
  }
  return { ok: true, total, preTaxBase, warnings };
}

/**
 * Whether it is safe to write `tax_total = 0`.
 *
 * `tax_total` is not display-only: the QB handlers pick the document's header
 * tax code with `hasTax = order.tax_total > 0`, so a zero sends the header as
 * Exempt and QuickBooks then charges no tax on ANY line, whatever the per-line
 * codes say. Zero is only ever correct when nothing on the order is taxable.
 */
export function isZeroTaxSafe(rewrite: TaxLineRewrite): boolean {
  return rewrite.taxedItemIds.length === 0;
}

/**
 * Dollars → integer cents.
 *
 * `toFixed` renders the decimal the value was PARSED from rather than the exact
 * binary, which is what makes it right here where `Math.round(n * 100)` is not:
 * 10.075 is stored as 10.07499999999999928946, so multiplying gives 1007.4999…
 * and rounds DOWN to 1007. Money must not lose a cent to a representation
 * detail, so the conversion happens once, at the boundary, and every sum after
 * it is integer arithmetic.
 */
function toCents(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Number(n.toFixed(4)) * 100 + (n < 0 ? -1e-9 : 1e-9));
}

function round2(n: number): number {
  return toCents(n) / 100;
}
