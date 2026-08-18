/**
 * src/lib/purchase-orders/qb-vendor-bill-enqueue.ts
 *
 * Phase 1.1 (docs/VENDOR_BILL_QB_SYNC_PLAN.md §5): freezes a confirmed
 * REGULAR vendor bill into a `qb_vendor_bill_pipeline` ADD row for the
 * qb-vendor-bill-poller to dispatch as a QuickBooks `BillAdd`.
 *
 * Rules:
 *  - Called AFTER the local confirm (VB number, landed lock, AVCO) committed —
 *    non-fatal by contract: a failed enqueue must never un-confirm the bill
 *    (callers wrap in try/catch; the drift/digest tooling surfaces gaps).
 *  - Fires ONLY when `QB_VENDOR_BILL_MODE === 'bill'` — while the flag is off
 *    NOTHING is queued (deliberate: pre-flip confirms must not accumulate
 *    waiting rows that would all dispatch the moment the flag flips).
 *  - BOTH document shapes ship (Phase 2, 2026-08-04). A bill with LINKED SIBLING
 *    bills (service/freight/tariff) carries item lines at the FULL LANDED cost
 *    plus one NEGATIVE ExpenseLine per sibling cancelling it, so A/P nets to
 *    what is owed. The vendor's `is_china_agent` flag decides NOTHING here — it
 *    is a POS relationship, invisible to QuickBooks; the structure of the
 *    document is its own fingerprint (see §shape below).
 *    Those lines are derived from the siblings' CURRENT totals
 *    (`qb-vendor-bill-clearing-lines.ts`) and PERSISTED to
 *    `vendor_bill.qb_clearing_lines` — that column is how the Mod later knows
 *    which shape this document has, so failing to write it makes the first
 *    edit restate the bill at raw cost.
 *  - One row per bill (UPDATE-first, INSERT-fallback — 2026-07-15 rule); a
 *    re-confirm after reopen reuses the row, bumping nothing: the poller's
 *    object-state gate refuses a second BillAdd for a generation whose
 *    qb_txn_id is already recorded.
 *
 * Payload contract — must match the poller (`qb-vendor-bill-poller.ts`) and
 * the bridge builder (`quickbooks-bridge/src/qbxml/builders/bill.ts`):
 *   item_lines[]:  PO-linked goods (LinkToTxn via po_txn_id + per-line
 *                  qb_po_txn_line_id; qb_item_list_id kept as the standalone
 *                  fallback for lines whose PO line id is still unknown —
 *                  the poller re-reads null ids pre-dispatch).
 *                  Local bills carry the RAW goods unit cost (plan §A.4:
 *                  no negative clearing — freight is a separate positive
 *                  ExpenseLine, never folded into the item cost).
 *   expense_lines[]: the bill's non-item charges as positive ExpenseLines —
 *                  freight_charge lines, qb_account lines, and the header
 *                  sales tax. QBXML BillAdd has NO header tax field (its only
 *                  slots are ExpenseLineAdd / ItemLineAdd), so vendor-charged
 *                  sales tax rides as its own ExpenseLine against a COGS
 *                  account. Whatever is emitted here MUST be the same set the
 *                  Mod path retains (qb-vendor-bill-mod-enqueue.ts) — a line
 *                  the Add creates but the Mod omits is DELETED BY OMISSION
 *                  the first time the bill is edited.
 */

import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
} from "./qb-purchase-dependency-chain";
import {
  allocateLineTotalsCents,
  freightWeights,
  computeLandedLines,
} from "./landed-allocation";
import {
  deriveClearingLines,
  type DerivedClearingLine,
} from "./qb-vendor-bill-clearing-lines";
import { loadClearingSiblings } from "./load-clearing-siblings";
import { resolveFreightPolicy } from "./freight-policy";
import {
  allLinesCarryAmount,
  costTruncationDriftCents,
  type CostTruncationLine,
} from "./qb-vendor-bill-cost-truncation-guard";

export type EnqueueKnex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

export type EnqueueResult =
  | { queued: true; pipelineRowId: string }
  | { queued: false; reason: string };

interface BillRow {
  id: string;
  number: string | null;
  reference_id: string | null;
  document_date: string | null;
  due_date: string | null;
  purchase_order_id: string | null;
  vendor_qb_list_id_snapshot: string | null;
  vendor_name_snapshot: string | null;
  qb_source: string | null;
  rebuild_generation: number;
  tax_amount_cents: number | string | null;
  tax_account_list_id: string | null;
  freight_included: boolean;
  freight_amount_cents: number | string | null;
  freight_allocation_basis: string | null;
}

interface PoRow {
  number: string | null;
  qb_purchase_order_list_id: string | null;
  vendor_id: string | null;
}

interface LineRow {
  id: string;
  line_kind: string | null;
  line_type: string | null;
  sku: string | null;
  description: string | null;
  qty: number;
  unit_cost_cents: number;
  /** Full landed cost — what a China-agent bill's item lines carry. */
  landed_unit_cost_cents: number | null;
  amount_cents: number | null;
  freight_account_list_id: string | null;
  qb_account_list_id: string | null;
  purchase_order_line_id: string | null;
  qb_po_txn_line_id: string | null;
  variant_qb_item_list_id: string | null;
  /** Only populated for basis 'cbm' — see the freight-weight vector below. */
  cbm_per_unit: number | null;
}

export async function enqueueQbVendorBillAdd(
  knex: EnqueueKnex,
  vendorBillId: string
): Promise<EnqueueResult> {
  if (process.env.QB_VENDOR_BILL_MODE !== "bill") {
    return { queued: false, reason: "QB_VENDOR_BILL_MODE is not 'bill' (flag off)" };
  }

  const billResult = await knex.raw(
    `SELECT vb.id, vb.number, vb.reference_id, vb.document_date, vb.due_date,
            vb.purchase_order_id, vb.vendor_qb_list_id_snapshot,
            vb.vendor_name_snapshot, vb.qb_source,
            vb.tax_amount_cents, vb.tax_account_list_id,
            vb.freight_included, vb.freight_amount_cents,
            vb.freight_allocation_basis,
            COALESCE(qvb.rebuild_generation, 0)::int AS rebuild_generation
       FROM vendor_bill vb
       LEFT JOIN qb_vendor_bill_pipeline qvb
         ON qvb.vendor_bill_id = vb.id AND qvb.deleted_at IS NULL
      -- service / freight / tariff bills are their own documents in
      -- QuickBooks too — 36 of them already live there. This filter said
      -- 'regular' only, so their confirm had nowhere to send them and four
      -- bills totalling $2,325.25 sat confirmed in the POS while QuickBooks
      -- never saw them (VB-1071/1072/1074/1075, all 2026-07-29).
      --
      -- No new builder was needed: both payload builders already accept a bill
      -- with no item lines — they only refuse when there are NO lines at all —
      -- and an account-only bill yields itemLines: [] with expenseLines: [n].
      -- (2026-08-04)
      WHERE vb.id = ? AND vb.deleted_at IS NULL
        AND vb.bill_type IN ('regular', 'service', 'freight', 'tariff')`,
    [vendorBillId]
  );
  const bill = (billResult.rows[0] ?? null) as BillRow | null;
  if (!bill) return { queued: false, reason: "bill not found" };
  // Fail-closed fence (durable invariant): an ADOPTED bill mirrors a QB bill
  // that already exists in QuickBooks — it must NEVER be (re)dispatched to QB,
  // even if some future caller reaches enqueue on one. Adopted bills (both the
  // legacy zero-line imports and the new "Full match" line-level mirrors) are
  // read-only w.r.t. the QB pipeline. See qb-vendor-bill-unlock.ts / PATCH /
  // bill-drift.ts for the sibling guards (owner rule 2026-07-23).
  if (bill.qb_source === "adopted") {
    return { queued: false, reason: "adopted_bill_readonly" };
  }
  if (!bill.purchase_order_id) {
    return { queued: false, reason: "bill has no purchase order" };
  }

  const poResult = await knex.raw(
    `SELECT number, qb_purchase_order_list_id, vendor_id
       FROM purchase_order
      WHERE id = ? AND deleted_at IS NULL`,
    [bill.purchase_order_id]
  );
  const po = (poResult.rows[0] ?? null) as PoRow | null;
  if (!po) return { queued: false, reason: "purchase order not found" };

  // WHICH DOCUMENT SHAPE — decided by the bill's STRUCTURE, not by its vendor.
  //
  //  · Bill WITH linked sibling bills — their cost is already folded into the
  //    landed item cost, so item lines go at the FULL LANDED figure plus one
  //    NEGATIVE ExpenseLine per sibling cancelling it. A/P nets to what is owed.
  //  · Bill WITHOUT siblings — item lines at the raw cost with sales tax folded
  //    in, and freight as its own positive ExpenseLine.
  //
  // It used to branch on `qb_vendor.metadata.is_china_agent`. That flag is a
  // POS-level relationship, not something QuickBooks knows or cares about, and
  // it happens to coincide with the structure only by history: all 20 regular
  // bills with linked siblings are China-agent today, and no local one has any.
  // Coincidence is not a rule — a China-agent bill with no siblings would look
  // for clearing lines that do not exist, and a local bill with a freight
  // sibling would post the freight TWICE. What QuickBooks needs to know is
  // whether the siblings' money is already inside the item cost.
  //
  // Matches how the Mod already decides (`usesClearingStructure =
  // qb_clearing_lines.length > 0`) — the structure is its own fingerprint.
  //
  // Until 2026-08-04 this shape simply refused ("Phase 2 handles QB dispatch"),
  // leaving those bills with no path to QuickBooks at all: four orphans worth
  // $2,325.25, and VB-1059 unable to come back after its rebuild.
  const siblings = await loadClearingSiblings(knex, vendorBillId);
  const usesClearingStructure = siblings.length > 0;

  const linesResult = await knex.raw(
    `SELECT vbl.id, vbl.line_kind, vbl.line_type, vbl.sku, vbl.description,
            vbl.qty, vbl.unit_cost_cents, vbl.landed_unit_cost_cents,
            vbl.amount_cents,
            vbl.freight_account_list_id, vbl.qb_account_list_id,
            vbl.purchase_order_line_id,
            pol.qb_txn_line_id AS qb_po_txn_line_id,
            pv.metadata ->> 'quickbooks_id' AS variant_qb_item_list_id,
            (pv.metadata ->> 'cbm') AS cbm_per_unit
       FROM vendor_bill_line vbl
       LEFT JOIN purchase_order_line pol
         ON pol.id = vbl.purchase_order_line_id AND pol.deleted_at IS NULL
       LEFT JOIN product_variant pv
         ON pv.id = vbl.product_variant_id AND pv.deleted_at IS NULL
      WHERE vbl.vendor_bill_id = ? AND vbl.deleted_at IS NULL
      ORDER BY vbl.created_at ASC`,
    [vendorBillId]
  );
  const lines = (linesResult.rows as Array<Record<string, unknown>>).map(
    (r) => {
      const rawCbm = r.cbm_per_unit;
      const parsedCbm =
        typeof rawCbm === "string" ? parseFloat(rawCbm) : null;
      return {
        ...r,
        cbm_per_unit: Number.isFinite(parsedCbm as number) ? parsedCbm : null,
      } as unknown as LineRow;
    }
  );

  const productLines = lines.filter(
    (l) =>
      (l.line_type ?? "product") === "product" &&
      (l.line_kind ?? "po_item") !== "freight_charge" &&
      // A line the operator zeroed out is not part of this invoice. It carries
      // no money anywhere in our own math — totals, landed allocation and the
      // PO remainder all ignore it — but the filter above only looked at the
      // line's TYPE, so it still rode into QuickBooks as an ItemLine with
      // Quantity 0: a junk row on the Bill in QB Desktop. Zeroing a line is
      // how a partial vendor invoice gets built, so this is the normal path,
      // not an edge case.
      Number(l.qty) > 0
  );

  // Sales tax rides INSIDE the item cost, not as its own ExpenseLine.
  //
  // WHY, and why it differs from freight/commission/tariff (which do go to
  // their own COGS accounts): ownership of `average_cost` depends on origin.
  // For a CHINA product the vendor bill owns it, so a pool can sit in a QB
  // expense account and our landed value still stands. For a USA product
  // QUICKBOOKS owns it — `sync-average-cost-core.ts` stamps
  // `average_cost = qb.avgCost` for every non-China variant. Anything not in
  // QB's item cost is therefore erased from our cost on the next Cost Sync.
  // Sales tax is a USA-vendor charge, so it has to be in the item cost or it
  // does not survive at all.
  //
  // Allocated by VALUE with the exact line-total allocator — the same basis
  // and the same engine as the landed pool — so Σ(line amounts) hits the
  // vendor invoice total to the penny. QB derives Amount = Quantity × Cost,
  // and the bridge caps Cost at 5 decimals (QBXML PRICETYPE; more triggers
  // error 3045), which the fractional per-unit below stays within.
  const taxCents = Number(bill.tax_amount_cents ?? 0);
  const taxByLine = allocateLineTotalsCents(
    Math.max(0, Math.round(taxCents)),
    productLines.map((l) => l.unit_cost_cents * l.qty)
  );

  // Capitalized freight (lib/purchase-orders/freight-policy.ts) — a bill's
  // `freight_charge` line(s) pooled and spread across the item lines exactly
  // like sales tax above, RECOMPUTED here from `allocateLineTotalsCents`
  // rather than trusted from any stored per-line figure: QB needs the exact
  // line-total split, not the rounded per-unit value the confirm route
  // persists for display. `freightWeights` is the SAME function
  // `computeLandedLines` uses internally, imported rather than re-derived, so
  // this can never compute a different split than what confirm allocated.
  //
  // Scoped to the non-clearing (local/USA) shape only, same as tax: a
  // China-agent bill's item lines already carry the FULL landed cost
  // (`landed_unit_cost_cents`, below) — computed by the SAME confirm-time
  // `computeLandedLines` call that already folded this pool in — so nothing
  // extra is needed there, and this recompute would only be redundant.
  let freightPolicy: ReturnType<typeof resolveFreightPolicy>;
  try {
    freightPolicy = resolveFreightPolicy({
      freightAllocationBasis: bill.freight_allocation_basis,
      freightChargeLineAmountsCents: lines
        .filter((l) => l.line_kind === "freight_charge")
        .map((l) => Number(l.amount_cents ?? l.unit_cost_cents ?? 0)),
      headerFreightAmountCents: bill.freight_included
        ? Number(bill.freight_amount_cents ?? 0)
        : 0,
    });
  } catch (error) {
    return {
      queued: false,
      reason: error instanceof Error ? error.message : "invalid freight allocation policy",
    };
  }
  const capitalizesFreightHere =
    freightPolicy.mode === "capitalized" && !usesClearingStructure;
  const freightByLine =
    freightPolicy.mode === "capitalized" && !usesClearingStructure
      ? allocateLineTotalsCents(
          Math.max(0, Math.round(freightPolicy.poolCents)),
          freightWeights(
            productLines.map((l) => ({
              qty: l.qty,
              unit_cost_cents: l.unit_cost_cents,
              cbm_per_unit: l.cbm_per_unit,
            })),
            freightPolicy.basis
          )
        )
      : productLines.map(() => 0);

  // EXACT per-line totals for the China/clearing shape — same money as the
  // negative clearing lines below (both derive from `siblings`' CURRENT
  // totals, the POS's own truth), fed through the same largest-remainder
  // engine (`computeLandedLines`/`allocateLineTotalsCents`) confirm-time uses.
  // Deliberately NOT `landed_unit_cost_cents × qty`: that per-unit figure is
  // an INTEGER from `allocatePerUnitCents` and can strand up to `qty − 1`
  // cents per pool (see landed-allocation.ts §THE FIX) — exactly the residue
  // this Amount field exists to stop losing. No sales tax pool here: it never
  // applies to the China shape (see the comment on `unitCost` below).
  const clearingLanded = usesClearingStructure
    ? computeLandedLines(
        productLines.map((l) => ({
          qty: l.qty,
          unit_cost_cents: l.unit_cost_cents,
          cbm_per_unit: l.cbm_per_unit,
        })),
        {
          commissionCents:
            siblings.find((s) => s.bill_type === "service")?.total_cents ?? 0,
          freightCents:
            siblings.find((s) => s.bill_type === "freight")?.total_cents ?? 0,
          tariffCents:
            siblings.find((s) => s.bill_type === "tariff")?.total_cents ?? 0,
          taxCents: 0,
        }
      )
    : null;

  const itemLines = productLines.map((l, i) => {
    const taxShare = taxByLine[i] ?? 0;
    const freightShare = freightByLine[i] ?? 0;
    const qty = Number(l.qty);
    // The China shape carries the FULL landed cost — commission and freight are
    // already inside it, which is exactly why the negative clearing lines below
    // have to cancel their sibling bills. Sales tax does not apply here: it is a
    // USA-vendor charge. This must match what the Mod sends
    // (`usesClearingStructure` → `landed_unit_cost_cents`), or the first edit
    // silently restates the bill.
    const unitCost = usesClearingStructure
      ? Number(l.landed_unit_cost_cents || l.unit_cost_cents)
      : qty > 0 && (taxShare > 0 || freightShare > 0)
        ? (l.unit_cost_cents * qty + taxShare + freightShare) / qty
        : l.unit_cost_cents;
    // Bridge compatibility (2026-08-18): `unit_cost_cents` still ships
    // unconditionally, exactly as before — the bridge is a separate Windows
    // deploy, so a bridge that has not picked up the Amount change yet must
    // still get a working `<Cost>`. `amount_cents` is additive: an old
    // bridge ignores the field; a new one prefers it and derives Amount
    // directly, sidestepping QBXML's 5-decimal Cost truncation entirely.
    const amountCents = usesClearingStructure
      ? (clearingLanded!.lines[i]!.landed_total_cents as number)
      : l.unit_cost_cents * qty + taxShare + freightShare;
    return {
      vendor_bill_line_id: l.id,
      purchase_order_line_id: l.purchase_order_line_id,
      sku: l.sku,
      qb_po_txn_line_id: l.qb_po_txn_line_id,
      quantity: l.qty,
      unit_cost_cents: unitCost,
      amount_cents: amountCents,
      qb_item_list_id: l.variant_qb_item_list_id,
      description: l.description,
    };
  });

  // The negative clearing lines. Built from the siblings' CURRENT totals —
  // the POS is the truth — so a rebuild also settles any drift they carry.
  let clearingLines: DerivedClearingLine[] = [];
  if (usesClearingStructure) {
    const derived = deriveClearingLines(siblings);
    if (!derived.ok) {
      // Fail closed. Posting without a clearing line overstates A/P by exactly
      // that sibling's amount, on a document that looks entirely normal.
      return { queued: false, reason: derived.reason };
    }
    clearingLines = derived.lines;
  }
  // Non-item charges, all positive ExpenseLines. Keep this set identical to
  // what the Mod path retains — QB deletes by omission on BillMod.
  const expenseLines: Array<{
    vendor_bill_line_id: string | null;
    account_list_id: string | null;
    amount_cents: number;
    memo: string | null;
  }> = lines
    .filter(
      (l) =>
        (l.line_type ?? "product") === "qb_account" &&
        // The tax_charge row is LOCAL bookkeeping only: it makes the bill's
        // payable (`SUM(unit_cost_cents × qty)`, read by
        // recomputeBillFinanceLinks) come to the vendor invoice total. Its
        // money reaches QuickBooks inside the item cost above — emitting it
        // here as well would bill the tax twice.
        l.line_kind !== "tax_charge" &&
        // freight_charge is excluded ONLY under a capitalized freight policy —
        // its money then rides inside the item cost, same reasoning as tax.
        // Under the legacy (NULL basis) policy this line ships exactly as
        // before: a positive ExpenseLine of pure expense. This condition MUST
        // stay identical to the Mod path's (qb-vendor-bill-mod-enqueue.ts) —
        // BillMod deletes by omission, so a bill's first edit under a
        // divergent condition would add or drop this line in QuickBooks.
        !(l.line_kind === "freight_charge" && freightPolicy.mode === "capitalized")
    )
    .map((l) => ({
      vendor_bill_line_id: l.id,
      account_list_id: l.freight_account_list_id ?? l.qb_account_list_id,
      amount_cents: l.amount_cents ?? l.unit_cost_cents,
      memo: l.description,
    }));

  // Fail-closed: tax/capitalized-freight with nowhere to ride. Every cent of
  // each header pool must land on a product line, or the QB bill posts an A/P
  // balance short by the difference that never clears against the real
  // payment. A pool-only bill (no product lines) has no item cost to absorb
  // either.
  if (taxCents > 0 || (capitalizesFreightHere && freightPolicy.mode === "capitalized" && freightPolicy.poolCents > 0)) {
    const placedTax = taxByLine.reduce((s, c) => s + c, 0);
    if (taxCents > 0 && placedTax !== Math.round(taxCents)) {
      return {
        queued: false,
        reason: `sales tax ${taxCents}c could not be placed on the item lines (placed ${placedTax}c)`,
      };
    }
    if (capitalizesFreightHere && freightPolicy.mode === "capitalized") {
      const placedFreight = freightByLine.reduce((s, c) => s + c, 0);
      if (placedFreight !== Math.round(freightPolicy.poolCents)) {
        return {
          queued: false,
          reason: `freight ${freightPolicy.poolCents}c could not be placed on the item lines (placed ${placedFreight}c)`,
        };
      }
    }
    // QBXML carries Cost, not Amount, and caps it at 5 decimals (PRICETYPE —
    // more is error 3045). QuickBooks then derives Amount = Quantity × Cost.
    // Below ~1,000 units a line that round-trip is exact; past ~2,500 the
    // truncated cost can land a cent off, and a cent off is a bill that never
    // clears. Simulate the bridge's own formatting and refuse rather than post
    // a total we know is wrong. Covers goods + tax + capitalized freight
    // together — they all land in the same `<Cost>`.
    //
    // CONDITIONAL, not deleted (2026-08-18) — see
    // qb-vendor-bill-cost-truncation-guard.ts for the full reasoning: skipped
    // only when every item line's payload will carry a finite `amount_cents`
    // (the bridge then derives `<Amount>` directly, nothing to round-trip).
    const costTruncationLines: CostTruncationLine[] = productLines.map(
      (l, i) => ({
        qty: Number(l.qty),
        unit_cost_cents: l.unit_cost_cents,
        tax_share_cents: taxByLine[i] ?? 0,
        freight_share_cents: freightByLine[i] ?? 0,
        amount_cents:
          l.unit_cost_cents * Number(l.qty) +
          (taxByLine[i] ?? 0) +
          (freightByLine[i] ?? 0),
      })
    );
    if (!allLinesCarryAmount(costTruncationLines)) {
      const drift = costTruncationDriftCents(costTruncationLines);
      if (drift > 0) {
        return {
          queued: false,
          reason:
            `sales tax/freight cannot be expressed within QuickBooks' 5-decimal unit cost ` +
            `on these quantities (off by ${drift}c) — split the bill or enter the ` +
            `amount on a smaller line`,
        };
      }
    }
  }

  if (expenseLines.some((l) => !l.account_list_id)) {
    return { queued: false, reason: "an expense line has no QB account" };
  }

  if (itemLines.length === 0 && expenseLines.length === 0) {
    return { queued: false, reason: "bill has no lines to send" };
  }

  const toDateOnly = (v: string | null): string | null => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };

  const payload = {
    vendor_bill_id: bill.id,
    po_id: bill.purchase_order_id,
    po_number: po.number,
    ref_number: bill.reference_id,
    memo: `EcoPowerTech ${bill.number ?? bill.id} / ${po.number ?? bill.purchase_order_id}`,
    vendor_qb_list_id: bill.vendor_qb_list_id_snapshot,
    vendor_name: bill.vendor_name_snapshot,
    txn_date: toDateOnly(bill.document_date),
    due_date: toDateOnly(bill.due_date),
    rebuild_generation: bill.rebuild_generation,
    po_txn_id: po.qb_purchase_order_list_id,
    item_lines: itemLines,
    // The clearing lines ride with the positive charges: to QuickBooks they are
    // all ExpenseLines, and only their sign differs.
    expense_lines: [
      ...expenseLines,
      ...clearingLines.map((c) => ({
        vendor_bill_line_id: null,
        account_list_id: c.account_list_id,
        amount_cents: c.amount_cents,
        memo: c.account_full_name,
      })),
    ],
  };

  // PERSIST the clearing lines, and do it before queueing.
  //
  // This is not bookkeeping — it is what tells the NEXT operation which shape
  // this document has. `qb-vendor-bill-mod-enqueue.ts` decides between the
  // China and local forms with `usesClearingStructure =
  // (qb_clearing_lines ?? []).length > 0`. If the Add sends clearing lines but
  // does not record them, the first Mod reads an empty array, treats the bill
  // as local, sends item lines at the RAW cost — and silently restates the
  // whole document in QuickBooks.
  //
  // VB-1059 is the live proof this matters: its rebuild TxnDel cleared the
  // column, which is why it lost the shape along with the link.
  if (usesClearingStructure) {
    await knex.raw(
      `UPDATE vendor_bill
          SET qb_clearing_lines = ?::jsonb, updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [JSON.stringify(clearingLines), vendorBillId]
    );
  }

  // One-row-per-bill: UPDATE-first, INSERT-fallback (2026-07-15 rule). Only a
  // non-terminal-in-flight row is reused; an already-synced row is left alone
  // (the poller's object-state gate owns re-adds via rebuild_generation).
  const updateResult = await knex.raw(
    `UPDATE qb_vendor_bill_pipeline
        SET status = 'waiting',
            intent = 'add',
            payload = ?::jsonb,
            qb_operation_id = NULL,
            retries = 0,
            last_error = NULL,
            next_retry_at = NULL,
            updated_at = NOW()
      WHERE vendor_bill_id = ?
        AND deleted_at IS NULL
        AND status IN ('waiting', 'error', 'failed_permanent')
      RETURNING id`,
    [JSON.stringify(payload), vendorBillId]
  );
  const updatedRow = updateResult.rows[0] as { id: string } | undefined;
  let pipelineRowId = updatedRow?.id ?? null;

  if (!pipelineRowId) {
    const existing = await knex.raw(
      `SELECT id, status FROM qb_vendor_bill_pipeline
        WHERE vendor_bill_id = ? AND deleted_at IS NULL LIMIT 1`,
      [vendorBillId]
    );
    const existingRow = existing.rows[0] as
      | { id: string; status: string }
      | undefined;
    if (existingRow) {
      // submitted/synced — never clobber an in-flight or completed ADD.
      return {
        queued: false,
        reason: `pipeline row already '${existingRow.status}' — not re-enqueued`,
      };
    }

    const insertResult = await knex.raw(
      `INSERT INTO qb_vendor_bill_pipeline
         (id, vendor_bill_id, purchase_order_id, status, intent, payload,
          created_at, updated_at)
       VALUES (?, ?, ?, 'waiting', 'add', ?::jsonb, NOW(), NOW())
       RETURNING id`,
      [
        `qbvbpipe_${Date.now().toString(36)}${Math.random()
          .toString(36)
          .slice(2, 10)}`,
        vendorBillId,
        bill.purchase_order_id,
        JSON.stringify(payload),
      ]
    );
    pipelineRowId = String(
      (insertResult.rows[0] as { id: string }).id
    );
  }

  const orderPayload = {
    ...payload,
    qb_vendor_bill_pipeline_id: pipelineRowId,
  };
  const operation = await enqueuePurchaseQbOperation(knex, {
    purchaseOrderId: bill.purchase_order_id,
    referenceId: vendorBillId,
    referenceType: "vendor_bill",
    step: "vendor_bill_add",
    payload: orderPayload,
    operationKey: purchaseOperationKey(
      "vendor_bill_add",
      vendorBillId,
      orderPayload
    ),
  });
  await knex.raw(
    `UPDATE qb_vendor_bill_pipeline
        SET order_pipeline_id = ?, updated_at = NOW()
      WHERE id = ?`,
    [operation.id, pipelineRowId]
  );
  return { queued: true, pipelineRowId };
}
