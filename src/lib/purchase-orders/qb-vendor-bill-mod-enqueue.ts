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
  | { queued: true; groupId: string; billIds: string[] }
  | { queued: false; reason: string };

type BillType = "regular" | "service" | "freight" | "tariff";

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
            l.unit_cost_cents, l.landed_unit_cost_cents, l.amount_cents,
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
    if (bill.bill_type !== "regular") {
      cost = raw;
      amount = raw * qty;
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

  const retainedClearing =
    bill.bill_type === "regular" && clearingAmounts
      ? (bill.qb_clearing_lines ?? []).map((line) => ({
          qb_txn_line_id: line.qb_txn_line_id,
          account_list_id: line.account_list_id,
          amount_cents:
            line.kind === "other"
              ? Number(line.amount_cents)
              : -clearingAmounts[line.kind],
          memo: line.account_full_name,
        }))
      : [];

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

  for (const bill of bills) {
    await enqueueOneBillMod(db, bill, regular, groupId);
  }
  return { queued: true, groupId, billIds: bills.map((b) => b.id) };
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

    if (!regular.purchase_order_id) {
      throw new Error(`${regular.number ?? regular.id}: missing purchase order`);
    }
    const orderPayload = {
      ...payload,
      qb_vendor_bill_pipeline_id: vendorBillPipelineId,
    };
    const operation = await enqueuePurchaseQbOperation(db, {
      purchaseOrderId: regular.purchase_order_id,
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
  if (!bill.purchase_order_id) {
    return { queued: false, reason: "bill has no purchase order" };
  }

  const groupId = randomUUID();
  // `bill` is its own context: buildPayload reads `regular.purchase_order_id`
  // only, and this bill has one.
  await enqueueOneBillMod(db, bill, bill, groupId);
  return { queued: true, groupId, billIds: [bill.id] };
}
