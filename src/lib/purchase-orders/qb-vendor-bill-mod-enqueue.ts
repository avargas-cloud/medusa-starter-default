import { randomUUID } from "crypto";
import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
} from "./qb-purchase-dependency-chain";
import {
  allocateLineTotalsCents,
  freightWeights,
  computeLandedLines,
} from "./landed-allocation";
import { resolveFreightPolicy, type FreightPolicy } from "./freight-policy";
import {
  allLinesCarryAmount,
  costTruncationDriftCents,
  type CostTruncationLine,
} from "./qb-vendor-bill-cost-truncation-guard";

export type VendorBillModKnex = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

export type VendorBillModEnqueueResult =
  | {
      queued: true;
      groupId: string;
      billIds: string[];
      /**
       * Group members that were NOT given a Mod because they do not live in
       * QuickBooks yet. Reported rather than silent: a caller that wants to
       * know whether the whole group was covered can ask.
       */
      skippedBillIds?: string[];
    }
  | { queued: false; reason: string };

type BillType = "regular" | "service" | "freight" | "tariff" | "expense";

interface BillRow {
  id: string;
  number: string | null;
  bill_type: BillType;
  purchase_order_id: string | null;
  reference_id: string | null;
  document_date: string | null;
  due_date: string | null;
  qb_txn_id: string | null;
  qb_edit_sequence: string | null;
  qb_source: string | null;
  qb_clearing_lines: ClearingLine[] | null;
  service_vendor_bill_id: string | null;
  freight_vendor_bill_id: string | null;
  tariff_vendor_bill_id: string | null;
  commission_amount_cents: number;
  freight_amount_cents: number;
  tariff_amount_cents: number;
  tax_amount_cents: number | string | null;
  freight_included: boolean;
  freight_allocation_basis: string | null;
}

interface ClearingLine {
  kind: "freight" | "commission" | "tariff" | "other";
  account_list_id: string;
  account_full_name?: string;
  amount_cents: number;
  qb_txn_line_id: string;
}

function dateValue(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function loadBill(
  db: VendorBillModKnex,
  id: string
): Promise<BillRow | null> {
  const result = await db.raw(
    `SELECT id, number, bill_type, purchase_order_id, reference_id,
            document_date, due_date, qb_txn_id, qb_edit_sequence, qb_source,
            qb_clearing_lines, service_vendor_bill_id, freight_vendor_bill_id,
            tariff_vendor_bill_id, commission_amount_cents,
            freight_amount_cents, tariff_amount_cents, tax_amount_cents,
            freight_included, freight_allocation_basis
       FROM vendor_bill
      WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  return (result.rows[0] as unknown as BillRow | undefined) ?? null;
}

async function resolveRegularBill(
  db: VendorBillModKnex,
  editedBill: BillRow
): Promise<BillRow | null> {
  if (editedBill.bill_type === "regular") return editedBill;
  const result = await db.raw(
    `SELECT id
       FROM vendor_bill
      WHERE deleted_at IS NULL
        AND bill_type = 'regular'
        AND (? = service_vendor_bill_id
          OR ? = freight_vendor_bill_id
          OR ? = tariff_vendor_bill_id)
      LIMIT 2`,
    [editedBill.id, editedBill.id, editedBill.id]
  );
  if (result.rows.length !== 1) return null;
  return loadBill(
    db,
    String((result.rows[0] as { id: unknown }).id)
  );
}

async function loadBillTotal(
  db: VendorBillModKnex,
  id: string | null,
  fallback: number
): Promise<number> {
  if (!id) return fallback;
  const result = await db.raw(
    `SELECT COALESCE(SUM(
              CASE WHEN COALESCE(line_type, 'product') = 'product'
                THEN unit_cost_cents::bigint * qty
                ELSE COALESCE(amount_cents, unit_cost_cents)::bigint
              END
            ), 0)::bigint AS total_cents
       FROM vendor_bill_line
      WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
    [id]
  );
  return Number(
    (result.rows[0] as { total_cents?: number | string } | undefined)
      ?.total_cents ?? fallback
  );
}

async function buildPayload(
  db: VendorBillModKnex,
  bill: BillRow,
  regular: BillRow,
  groupId: string
): Promise<Record<string, unknown>> {
  if (!bill.qb_txn_id || !bill.qb_edit_sequence) {
    throw new Error(`${bill.number ?? bill.id}: missing QB TxnID/EditSequence`);
  }
  if (bill.qb_source === "adopted") {
    throw new Error(`${bill.number ?? bill.id}: adopted_bill_readonly`);
  }

  const lineResult = await db.raw(
    `SELECT l.id, l.line_type, l.line_kind, l.qty,
            l.unit_cost_cents, l.landed_unit_cost_cents, l.landed_total_cents,
            l.amount_cents,
            l.qb_txn_line_id,
            COALESCE(l.freight_account_list_id, l.qb_account_list_id)
              AS account_list_id,
            pv.metadata ->> 'quickbooks_id' AS qb_item_list_id,
            (pv.metadata ->> 'cbm') AS cbm_per_unit,
            l.description
       FROM vendor_bill_line l
       LEFT JOIN product_variant pv
         ON pv.id = l.product_variant_id AND pv.deleted_at IS NULL
      WHERE l.vendor_bill_id = ? AND l.deleted_at IS NULL
      ORDER BY l.created_at, l.id`,
    [bill.id]
  );

  const lineRows = lineResult.rows as Record<string, unknown>[];
  const productRows = lineRows.filter(
    (line) =>
      String(line.line_type ?? "product") === "product" &&
      // Same rule as the Add (qb-vendor-bill-enqueue.ts): a zeroed line is not
      // on the invoice, so it is not on the QuickBooks Bill either. The two
      // paths MUST agree — the Mod's whole contract is to reproduce what the
      // Add sent. Here omission is also the mechanism: BillMod deletes by
      // omission, so a line the operator drops to 0 after it was synced is
      // removed from the QB Bill, which is exactly the intent.
      Number(line.qty ?? 0) > 0
  );

  // WHICH COST BASIS — this must match whatever the Add put in QuickBooks, or
  // the first edit silently restates the bill.
  //
  // There are two document shapes behind `bill_type = 'regular'`:
  //
  //  · CHINA AGENT — item lines at the FULL landed cost, with negative
  //    clearing ExpenseLines cancelling the sibling service/freight/tariff
  //    bills so A/P still nets to what is owed. `qb_clearing_lines` is
  //    populated exactly for these, so it is the shape's own fingerprint.
  //
  //  · LOCAL / USA — item lines at the RAW invoice cost (plus sales tax, which
  //    has to be in the item cost to survive Cost Sync: see
  //    qb-vendor-bill-enqueue.ts), with freight as its own positive
  //    ExpenseLine. This is what qb-vendor-bill-enqueue.ts sends.
  //
  // Sending landed for BOTH — the previous behaviour — meant a Mod on a local
  // bill folded commission/freight/tariff into the item cost while ALSO
  // leaving their positive ExpenseLines in place, double-counting them in
  // QuickBooks and inflating the bill.
  const usesClearingStructure = (bill.qb_clearing_lines ?? []).length > 0;

  // Sales tax, allocated by value on exact line totals — identical basis and
  // engine to the Add, so a Mod reproduces the same per-unit cost.
  const taxCents = Number(regular.tax_amount_cents ?? 0);
  const taxByLine = allocateLineTotalsCents(
    Math.max(0, Math.round(taxCents)),
    productRows.map((l) => Number(l.unit_cost_cents) * Number(l.qty))
  );

  // Capitalized freight (lib/purchase-orders/freight-policy.ts) — same policy
  // read the Add already uses, so a Mod on a bill under a capitalized basis
  // reproduces exactly the same item cost split, and the `freight_charge`
  // line's exclusion from `expenseLines` below stays consistent. Read from
  // `regular` (never `bill`): the policy is a property of the regular bill's
  // document even when a sibling service/freight/tariff bill is the one
  // being Mod'd.
  let freightPolicy: FreightPolicy;
  try {
    freightPolicy = resolveFreightPolicy({
      freightAllocationBasis: regular.freight_allocation_basis,
      freightChargeLineAmountsCents: lineRows
        .filter((l) => l.line_kind === "freight_charge")
        .map((l) => Number(l.amount_cents ?? l.unit_cost_cents ?? 0)),
      headerFreightAmountCents: regular.freight_included
        ? Number(regular.freight_amount_cents ?? 0)
        : 0,
    });
  } catch (error) {
    throw new Error(
      `${bill.number ?? bill.id}: ${error instanceof Error ? error.message : "invalid freight allocation policy"}`
    );
  }
  const freightByLine =
    freightPolicy.mode === "capitalized" && !usesClearingStructure
      ? allocateLineTotalsCents(
          Math.max(0, Math.round(freightPolicy.poolCents)),
          freightWeights(
            productRows.map((l) => {
              const rawCbm = l.cbm_per_unit;
              const parsedCbm =
                typeof rawCbm === "string" ? parseFloat(rawCbm) : NaN;
              return {
                qty: Number(l.qty),
                unit_cost_cents: Number(l.unit_cost_cents),
                cbm_per_unit: Number.isFinite(parsedCbm) ? parsedCbm : null,
              };
            }),
            freightPolicy.basis
          )
        )
      : productRows.map(() => 0);

  // Fail-closed: sales tax and capitalized freight must land ENTIRELY on the
  // item lines, and the combined per-unit cost must round-trip through
  // QuickBooks' 5-decimal <Cost> truncation (QBXML PRICETYPE; more triggers
  // error 3045) — same two checks the Add already runs
  // (qb-vendor-bill-enqueue.ts ~lines 385-430), ported here because the Mod
  // builds this exact same <Cost> and was posting whatever it computed
  // without verifying it survives the bridge's formatting. Both checks are
  // scoped to the local/USA shape (`capitalizesFreightHere`) — same as the
  // Add: a China-agent bill's item lines carry the full LANDED cost, already
  // folded in at confirm time, so nothing here applies to it. Under the
  // legacy (NULL basis) freight policy the freight half is skipped, same as
  // the Add — freight there is a plain ExpenseLine, never in <Cost>, so
  // there is nothing to round-trip and the 2 already-`synced` legacy bills
  // must see this path unchanged.
  const capitalizesFreightHere =
    freightPolicy.mode === "capitalized" && !usesClearingStructure;
  if (
    taxCents > 0 ||
    (capitalizesFreightHere &&
      freightPolicy.mode === "capitalized" &&
      freightPolicy.poolCents > 0)
  ) {
    const placedTax = taxByLine.reduce((s, c) => s + c, 0);
    if (taxCents > 0 && placedTax !== Math.round(taxCents)) {
      throw new Error(
        `${bill.number ?? bill.id}: sales tax ${taxCents}c could not be placed on the item lines (placed ${placedTax}c)`
      );
    }
    if (capitalizesFreightHere && freightPolicy.mode === "capitalized") {
      const placedFreight = freightByLine.reduce((s, c) => s + c, 0);
      if (placedFreight !== Math.round(freightPolicy.poolCents)) {
        throw new Error(
          `${bill.number ?? bill.id}: freight ${freightPolicy.poolCents}c could not be placed on the item lines (placed ${placedFreight}c)`
        );
      }
    }
    // CONDITIONAL, not deleted (2026-08-18) — see
    // qb-vendor-bill-cost-truncation-guard.ts for the full reasoning, and
    // mirrors the Add (qb-vendor-bill-enqueue.ts, same date, same shared
    // module — the two MUST reach the same verdict on the same bill or the
    // ADD accepts a bill the first MOD then can't reproduce. Computed from
    // the SAME figures `itemLines` below uses in this branch
    // (`raw * qty + taxShare + freightShare`) — `itemLines` itself is built
    // further down, after this guard runs.
    const costTruncationLines: CostTruncationLine[] = productRows.map(
      (line, i) => {
        const qty = Number(line.qty);
        const raw = Number(line.unit_cost_cents);
        const taxShare = taxByLine[i] ?? 0;
        const freightShare = freightByLine[i] ?? 0;
        return {
          qty,
          unit_cost_cents: raw,
          tax_share_cents: taxShare,
          freight_share_cents: freightShare,
          amount_cents: raw * qty + taxShare + freightShare,
        };
      }
    );
    if (!allLinesCarryAmount(costTruncationLines)) {
      const drift = costTruncationDriftCents(costTruncationLines);
      if (drift > 0) {
        throw new Error(
          `${bill.number ?? bill.id}: sales tax/freight cannot be expressed within QuickBooks' 5-decimal unit cost on these quantities (off by ${drift}c) — split the bill or enter the amount on a smaller line`
        );
      }
    }
  }

  // Same money the retained clearing lines below cancel — CURRENT sibling
  // totals, not what was true at the last Add/Mod. Hoisted here (instead of
  // inside `retainedClearing`) so the item lines' `amount_cents` and the
  // negative clearing lines are built from the identical figures; a Mod is
  // exactly the moment those totals can have drifted since the Add.
  const clearingAmounts =
    bill.bill_type === "regular"
      ? {
          commission: await loadBillTotal(
            db,
            regular.service_vendor_bill_id,
            Number(regular.commission_amount_cents ?? 0)
          ),
          freight: await loadBillTotal(
            db,
            regular.freight_vendor_bill_id,
            Number(regular.freight_amount_cents ?? 0)
          ),
          tariff: await loadBillTotal(
            db,
            regular.tariff_vendor_bill_id,
            Number(regular.tariff_amount_cents ?? 0)
          ),
        }
      : null;

  // EXACT per-line totals for the China/clearing shape — mirrors the Add
  // (qb-vendor-bill-enqueue.ts): fed through `computeLandedLines` /
  // `allocateLineTotalsCents`, NEVER `landed_unit_cost_cents × qty` (that
  // per-unit figure is an INTEGER from `allocatePerUnitCents` and strands up
  // to `qty − 1` cents per pool — see landed-allocation.ts §THE FIX). No
  // sales tax pool: it never applies to the China shape.
  const clearingLanded =
    usesClearingStructure && clearingAmounts
      ? computeLandedLines(
          productRows.map((l) => {
            const rawCbm = l.cbm_per_unit;
            const parsedCbm =
              typeof rawCbm === "string" ? parseFloat(rawCbm) : NaN;
            return {
              qty: Number(l.qty),
              unit_cost_cents: Number(l.unit_cost_cents),
              cbm_per_unit: Number.isFinite(parsedCbm) ? parsedCbm : null,
            };
          }),
          {
            commissionCents: clearingAmounts.commission,
            freightCents: clearingAmounts.freight,
            tariffCents: clearingAmounts.tariff,
            taxCents: 0,
          }
        )
      : null;

  const itemLines = productRows.map((line, i) => {
    if (!line.qb_txn_line_id) {
      throw new Error(
        `${bill.number ?? bill.id}: line ${String(line.id)} has no QB TxnLineID`
      );
    }
    const qty = Number(line.qty);
    const raw = Number(line.unit_cost_cents);
    let cost: number;
    let amount: number;
    // The confirm route already computed and PERSISTED the exact landed money
    // for this line (`landed_total_cents`) — read it instead of recomputing an
    // independent copy, same consolidation as the Add (qb-vendor-bill-enqueue.ts,
    // 2026-08-21). NULL means this line predates the column / was never
    // backfilled: fall back to the legacy recompute below.
    const persistedLandedTotal =
      line.landed_total_cents == null ? null : Number(line.landed_total_cents);
    if (bill.bill_type !== "regular") {
      cost = raw;
      amount = raw * qty;
    } else if (persistedLandedTotal != null) {
      amount = persistedLandedTotal;
      cost = qty > 0 ? persistedLandedTotal / qty : raw;
    } else if (usesClearingStructure) {
      cost = Number(line.landed_unit_cost_cents || line.unit_cost_cents);
      amount = clearingLanded!.lines[i]!.landed_total_cents;
    } else {
      const taxShare = taxByLine[i] ?? 0;
      const freightShare = freightByLine[i] ?? 0;
      cost =
        qty > 0 && (taxShare > 0 || freightShare > 0)
          ? (raw * qty + taxShare + freightShare) / qty
          : raw;
      amount = raw * qty + taxShare + freightShare;
    }
    return {
      vendor_bill_line_id: String(line.id),
      qb_txn_line_id: String(line.qb_txn_line_id),
      qb_item_list_id: line.qb_item_list_id
        ? String(line.qb_item_list_id)
        : null,
      quantity: qty,
      unit_cost_cents: cost,
      amount_cents: amount,
    };
  });

  const localExpenseLines = lineRows
    .filter(
      (line) =>
        String(line.line_type ?? "") === "qb_account" &&
        // Local-only bookkeeping row; its money is already inside the item
        // cost above. Same exclusion as the Add path.
        String(line.line_kind ?? "") !== "tax_charge" &&
        // freight_charge is excluded ONLY under a capitalized freight policy
        // — MUST stay the exact same condition as the Add
        // (qb-vendor-bill-enqueue.ts): BillMod deletes by omission, so a
        // divergent condition adds or drops this line on the bill's first
        // edit.
        !(
          String(line.line_kind ?? "") === "freight_charge" &&
          freightPolicy.mode === "capitalized"
        )
    )
    .map((line) => {
      if (!line.account_list_id) {
        throw new Error(
          `${bill.number ?? bill.id}: account line ${String(line.id)} lacks a QB account`
        );
      }
      // A MISSING TxnLineID means a charge line added after the bill was
      // already synced. QBXML allows exactly that: an ExpenseLineMod with no
      // TxnLineID is sent as -1 and QuickBooks appends it — unlike an ITEM
      // line, which cannot be added PO-linked via Mod and is what the rebuild
      // flow exists for.
      //
      // This used to throw for a service / freight / tariff bill, on the
      // reasoning that OUR Add created every line so a null had to be
      // corruption. That stopped being true the moment the operator could
      // reopen one and add a charge: a legal edit came back as an integrity
      // error, and the only way out looked like deleting and recreating a
      // document that never needed it. Those bills carry no PO-linked item
      // lines at all, so they are ALWAYS a Mod.
      return {
        vendor_bill_line_id: String(line.id),
        qb_txn_line_id: line.qb_txn_line_id
          ? String(line.qb_txn_line_id)
          : null,
        account_list_id: String(line.account_list_id),
        amount_cents: Number(line.amount_cents ?? line.unit_cost_cents),
        memo: line.description ? String(line.description) : undefined,
      };
    });

  // THE AMOUNTS ARE DERIVED LIVE; the persisted rows supply only IDENTITY
  // (which account, which QB line, which sibling). `clearingSnapshot` keeps
  // every field so the confirm can write the column back verbatim — see
  // `clearing_lines` in the payload below.
  const clearingSnapshot: ClearingLine[] =
    bill.bill_type === "regular" && clearingAmounts
      ? (bill.qb_clearing_lines ?? []).map((line) => ({
          ...line,
          amount_cents:
            line.kind === "other"
              ? Number(line.amount_cents)
              : -clearingAmounts[line.kind],
        }))
      : [];

  const retainedClearing = clearingSnapshot.map((line) => ({
    qb_txn_line_id: line.qb_txn_line_id,
    account_list_id: line.account_list_id,
    amount_cents: line.amount_cents,
    memo: line.account_full_name,
  }));

  // BillMod DELETES BY OMISSION (quickbooks-bridge/src/qbxml/builders/bill.ts
  // §BillMod): every line the caller leaves out is removed from the QB bill.
  // A regular bill used to send ONLY its China-agent clearing lines here, so
  // any freight-charge / account / sales-tax ExpenseLine the Add had created
  // silently vanished from QuickBooks on the first edit — leaving the QB bill
  // short by exactly those amounts against a payment that still had to clear.
  // The retained set must be everything the Add path emits.
  const expenseLines =
    bill.bill_type === "regular"
      ? [...retainedClearing, ...localExpenseLines]
      : localExpenseLines;
  if (itemLines.length === 0 && expenseLines.length === 0) {
    throw new Error(`${bill.number ?? bill.id}: no retained QB lines`);
  }

  return {
    __mod_group_id: groupId,
    vendor_bill_id: bill.id,
    txn_id: bill.qb_txn_id,
    edit_sequence: bill.qb_edit_sequence,
    ref_number: bill.reference_id,
    txn_date: dateValue(bill.document_date),
    due_date: dateValue(bill.due_date),
    memo: `EcoPowerTech ${bill.number ?? bill.id}`,
    item_lines: itemLines,
    expense_lines: expenseLines,
    // WHAT QUICKBOOKS WILL HOLD once this Mod confirms (2026-09-03).
    //
    // `vendor_bill.qb_clearing_lines` is documented as "how the Mod later knows
    // what QuickBooks holds", and only the ADD ever wrote it. The Mod read it,
    // sent FRESH amounts, and left the column quoting the old ones — so after a
    // sibling was corrected and the group re-confirmed, the column described a
    // document that no longer existed. `deriveClearingDrift` compares against
    // that column, so the bill's "needs review" banner became a false positive
    // with no way to clear, and `verify-clearing-drift` a permanent red.
    // Measured on VB-1128: QuickBooks −$380.68, column −$388.87, banner stuck.
    //
    // Carried in the payload rather than re-derived at confirm time: a sibling
    // can change again while the Mod is in flight, and this column records what
    // was SENT, not what would be right now. It is applied on CONFIRM (see
    // poll-submitted-rows.ts) and not here, so a Mod that never lands leaves the
    // old amounts in place — the banner stays, telling the truth about a
    // QuickBooks document that really is still stale.
    ...(clearingSnapshot.length > 0
      ? { clearing_lines: clearingSnapshot }
      : {}),
  };
}

/**
 * Freezes every linked China-agency BillMod in the caller's transaction.
 * Either the whole Regular/Service/Freight/Tariff group is queued, or none is.
 */
export async function enqueueChinaAgencyVendorBillModGroup(
  db: VendorBillModKnex,
  editedBillId: string
): Promise<VendorBillModEnqueueResult> {
  if (process.env.QB_VENDOR_BILL_MODE !== "bill") {
    return { queued: false, reason: "QB_VENDOR_BILL_MODE is not 'bill'" };
  }
  const edited = await loadBill(db, editedBillId);
  if (!edited) return { queued: false, reason: "vendor bill not found" };
  if (edited.qb_source === "adopted") {
    return { queued: false, reason: "adopted_bill_readonly" };
  }
  if (!edited.qb_txn_id) {
    return { queued: false, reason: "bill is not linked to QuickBooks" };
  }
  const regular = await resolveRegularBill(db, edited);
  if (!regular) {
    return { queued: false, reason: "linked regular bill not found or ambiguous" };
  }

  const ids = [
    regular.id,
    regular.service_vendor_bill_id,
    regular.freight_vendor_bill_id,
    regular.tariff_vendor_bill_id,
  ].filter((id): id is string => Boolean(id));
  const groupId = `qbvbmodgrp_${randomUUID().replace(/-/g, "")}`;
  const bills: BillRow[] = [];
  for (const id of ids) {
    const bill = await loadBill(db, id);
    if (!bill) throw new Error(`Linked vendor bill ${id} was not found`);
    bills.push(bill);
  }

  // A GROUP MEMBER THAT DOES NOT LIVE IN QUICKBOOKS GETS NO Mod (2026-09-03).
  //
  // This loop used to Mod every sibling the regular points at, and `buildPayload`
  // throws for one without a TxnID/EditSequence. That is a DEADLOCK on the only
  // shape that reaches it: the regular's confirm runs `dispatchConfirmedSiblings`
  // FIRST, which enqueues a BillAdd for each sibling that is confirmed and not
  // in QuickBooks yet — an Add that has only been QUEUED, so the sibling's
  // `qb_txn_id` is still null one statement later when this group runs. The
  // throw then rolled back the same transaction that had just queued those Adds,
  // so the confirm could never succeed and the Adds never survived either.
  //
  // Measured on production 2026-09-03: VB-1128 (VEETECH, PO of 2026-08-21) had
  // been synced under the older bug where no sibling was ever enqueued at all,
  // so its QuickBooks Bill carried −$388.87 and −$585.00 of clearing lines
  // against VB-1129 and VB-1130, neither of which existed there. Every attempt
  // to re-confirm it returned 422 `VB-1129: missing QB TxnID/EditSequence`.
  //
  // Skipping is the correct operation, not a workaround: a BillMod names a
  // document by TxnID, so "modify a bill QuickBooks has never seen" is not an
  // operation that exists. The Add queued a moment earlier is what puts it
  // there, and the dependency chain is serial per purchase order, so it lands
  // BEFORE this Mod — which is also why A/P is never short in between.
  //
  // The REGULAR is never skipped: it reached this function precisely because it
  // has a `qb_txn_id` (the caller branches Add/Mod on that), so a missing one
  // here is damage and must stay loud.
  const modBills = bills.filter(
    (bill) => bill.id === regular.id || Boolean(bill.qb_txn_id)
  );
  const skippedBillIds = bills
    .filter((bill) => !modBills.includes(bill))
    .map((bill) => bill.id);

  for (const bill of modBills) {
    await enqueueOneBillMod(db, bill, regular, groupId);
  }
  return {
    queued: true,
    groupId,
    billIds: modBills.map((b) => b.id),
    skippedBillIds,
  };
}

/**
 * Freezes ONE bill's BillMod payload and its pipeline rows.
 *
 * Extracted so the group path and the single-bill path share it byte for byte:
 * two copies of "how a BillMod is queued" is two chances for them to drift, and
 * the Mod's whole contract is reproducing exactly what the Add sent.
 *
 * `context` supplies the purchase order for the dependency chain — the regular
 * bill for a group, or the bill itself when it syncs alone.
 */
async function enqueueOneBillMod(
  db: VendorBillModKnex,
  bill: BillRow,
  context: BillRow,
  groupId: string
): Promise<void> {
  {
    const regular = context;
    const payload = await buildPayload(db, bill, regular, groupId);
    const existing = await db.raw(
      `SELECT id, status
         FROM qb_vendor_bill_pipeline
        WHERE vendor_bill_id = ? AND deleted_at IS NULL
        FOR UPDATE`,
      [bill.id]
    );
    const row = existing.rows[0] as
      | { id: string; status: string }
      | undefined;
    if (row && ["waiting", "submitted", "error"].includes(String(row.status))) {
      throw new Error(
        `${bill.number ?? bill.id}: QuickBooks sync is already ${String(row.status)}`
      );
    }
    let vendorBillPipelineId: string;
    if (row) {
      vendorBillPipelineId = String(row.id);
      await db.raw(
        `UPDATE qb_vendor_bill_pipeline
            SET purchase_order_id = ?, status = 'waiting', intent = 'mod',
                payload = ?::jsonb, snapshot = NULL,
                qb_operation_id = NULL, qb_txn_id = ?,
                qb_ref_number = ?, edit_sequence = ?, retries = 0,
                next_retry_at = NULL, last_error = NULL, updated_at = NOW()
          WHERE id = ?`,
        [
          regular.purchase_order_id,
          JSON.stringify(payload),
          bill.qb_txn_id,
          bill.reference_id,
          bill.qb_edit_sequence,
          String(row.id),
        ]
      );
    } else {
      vendorBillPipelineId = `qbvbpipe_${randomUUID().replace(/-/g, "")}`;
      await db.raw(
        `INSERT INTO qb_vendor_bill_pipeline
           (id, vendor_bill_id, purchase_order_id, status, intent, payload,
            qb_txn_id, qb_ref_number, edit_sequence, retries, created_at, updated_at)
         VALUES (?, ?, ?, 'waiting', 'mod', ?::jsonb, ?, ?, ?, 0, NOW(), NOW())`,
        [
          vendorBillPipelineId,
          bill.id,
          regular.purchase_order_id,
          JSON.stringify(payload),
          bill.qb_txn_id,
          bill.reference_id,
          bill.qb_edit_sequence,
        ]
      );
    }

    // Same rule as the Add (qb-vendor-bill-enqueue.ts): only a REGULAR bill
    // genuinely needs a purchase order — its item lines are PO-linked goods and
    // `LinkToTxn` has nothing to point at without one. For every other type, no
    // PO is a document SHAPE, not damage. See the note on the single-bill guard
    // below for what the asymmetry cost.
    if (!regular.purchase_order_id && regular.bill_type === "regular") {
      throw new Error(`${regular.number ?? regular.id}: missing purchase order`);
    }
    const orderPayload = {
      ...payload,
      qb_vendor_bill_pipeline_id: vendorBillPipelineId,
    };
    const operation = await enqueuePurchaseQbOperation(db, {
      // A bill with no purchase order chains by its OWN id — the same key its
      // Add used — so Add → Mod on the same document stays serial.
      purchaseOrderId: regular.purchase_order_id ?? regular.id,
      referenceId: bill.id,
      referenceType: "vendor_bill",
      step: "vendor_bill_mod",
      qbTxnId: bill.qb_txn_id,
      payload: orderPayload,
      operationKey: purchaseOperationKey(
        "vendor_bill_mod",
        bill.id,
        orderPayload
      ),
    });
    await db.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET order_pipeline_id = ?, updated_at = NOW()
        WHERE id = ?`,
      [operation.id, vendorBillPipelineId]
    );
  }
}

/**
 * Queues a BillMod for ONE service / freight / tariff bill, on its own.
 *
 * WHY SEPARATE FROM THE GROUP (owner decision, 2026-08-04)
 * -------------------------------------------------------
 * `enqueueChinaAgencyVendorBillModGroup` sends the regular bill and its
 * service/freight/tariff siblings together, all or nothing. That is right when
 * the group is being confirmed as a unit — and wrong when an operator corrects
 * one service bill, because it would drag a regular bill that may be mid-repair
 * (draft, deleted from QuickBooks, half-edited) along with it.
 *
 * So each of these bills syncs independently. `buildPayload` only needs the
 * "regular" argument to resolve a purchase order for the dependency chain, and
 * a service bill carries its own `purchase_order_id` — so it acts as its own
 * context and no sibling is touched.
 *
 * THE COST OF THAT INDEPENDENCE, and why the UI has to close it: on a China
 * agent PO the NEGATIVE CLEARING LINES live on the REGULAR bill and cancel
 * these siblings. Changing a service bill alone leaves those clearing lines
 * quoting the old figure, so QuickBooks' A/P is off by the difference until the
 * regular bill is re-sent. The regular is therefore flagged as needing a resync
 * — that flag is not decoration, it is what closes the gap.
 */
export async function enqueueVendorBillModSingle(
  db: VendorBillModKnex,
  vendorBillId: string
): Promise<VendorBillModEnqueueResult> {
  if (process.env.QB_VENDOR_BILL_MODE !== "bill") {
    return { queued: false, reason: "QB_VENDOR_BILL_MODE is not 'bill'" };
  }
  const bill = await loadBill(db, vendorBillId);
  if (!bill) return { queued: false, reason: "vendor bill not found" };
  if (bill.bill_type === "regular") {
    // The regular bill keeps the group path: its clearing lines are computed
    // against the siblings, so sending it alone is a different operation.
    return { queued: false, reason: "regular bills use the group Mod" };
  }
  if (bill.qb_source === "adopted") {
    return { queued: false, reason: "adopted_bill_readonly" };
  }
  if (!bill.qb_txn_id) {
    return { queued: false, reason: "bill is not linked to QuickBooks" };
  }
  // NO PURCHASE ORDER IS A DOCUMENT SHAPE, NOT DAMAGE — and this guard is the
  // half that was left behind (2026-09-03).
  //
  // `bdfbecaf` (2026-08-31) generalised exactly this rule, and its own commit
  // message says so: "sólo un regular exige PO". But it applied the rule to the
  // ADD alone — `git show bdfbecaf -- <this file>` is EMPTY. So a service bill
  // with no purchase order could be created in QuickBooks and then never
  // corrected again: the Add went through, the bill came back with a TxnID, and
  // every later edit hit this refusal forever.
  //
  // Two real shapes live here, both named by the owner: a SERVICE bill for a
  // sales commission, and an outsourced-services (subcontractor) bill. Neither
  // has anything to purchase. Measured the day this was found: VB-1146, 1147,
  // 1148 and 1149 were already in QuickBooks and all four were uneditable.
  //
  // And the same commit made the standalone confirm transactional and LOUD, so
  // the leftover carve-out stopped being a silent skip and became a 500 in the
  // operator's face — which is the only reason it surfaced at all.
  //
  // The rule that replaces it is structural and identical to the Add's: a bill
  // with no purchase order has no regular bill that could absorb or clear it,
  // so it is its own document, and `enqueueOneBillMod` keys its dependency
  // chain by its own id. Only `regular` truly cannot exist without a PO — and
  // a regular bill NEVER reaches this line, because the check above already
  // sends it to the group Mod. So there is deliberately no PO check here: the
  // one that still bites lives in `enqueueOneBillMod`, where both paths meet.
  // Re-adding a copy here would only be a second place for it to drift.

  const groupId = randomUUID();
  // `bill` is its own context: buildPayload reads `regular.purchase_order_id`
  // only, and this bill either has one or chains by its own id.
  await enqueueOneBillMod(db, bill, bill, groupId);
  return { queued: true, groupId, billIds: [bill.id] };
}
