/**
 * China Finance — vendor bill DRIFT detection.
 *
 * Single source of truth for "does this vendor bill still agree with the
 * document it is supposed to mirror?". Consumed by BOTH
 * `GET /admin/vendor-bills/:id` and `GET /admin/china-finance/bills`, so the
 * operator sees the same verdict wherever they are looking.
 *
 * Four rules, one per bill shape:
 *
 *   regular, NOT receipt-pinned  → compare product lines vs the PO's ordered lines.
 *   regular, receipt-pinned      → compare product lines vs the RECEIPT's lines.
 *   service (agent commission)   → reconcile against the goods bill (see below).
 *   freight                      → compare the freight bill total vs the amount
 *                                  the regular bill declares as freight.
 *
 * WHY the receipt-pinned rule exists (this was a real blind spot): the previous
 * `po_drift` check SUPPRESSED itself entirely once a bill was pinned to a
 * receipt, on the theory that a receipt-mirroring bill legitimately has less qty
 * than the PO ordered (partial shipment). True — but it then never compared
 * against the receipt either, so a bill that disagreed with its OWN pinned
 * receipt was silent. VB-1045 billed 50 units of a SKU whose receipt says 25
 * ($111.50) and showed no signal at all once it got pinned.
 *
 * WHY the commission rule is a reconciliation and not a formula: the agent
 * issues its own service invoice and computes the commission itself. We do NOT
 * recompute it. Instead we invert it — `implied_goods = commission / rate` — and
 * compare that against what the goods bill declares. A mismatch means one of the
 * two documents is stale (historically it has always been ours). The tolerance
 * absorbs the agent's own cent-level rounding so it never raises a false alarm.
 */

export type BillDriftKind =
  | "po_lines"
  | "receipt_lines"
  | "commission"
  | "freight";

export interface BillDriftLine {
  sku: string;
  bill_qty: number;
  source_qty: number;
  unit_cost_cents: number;
  /** signed: (bill − source) valued at the bill's unit cost. */
  delta_cents: number;
}

export interface BillDrift {
  vendor_bill_id: string;
  vendor_bill_number: string | null;
  kind: BillDriftKind;
  /** Signed: bill − source. `> 0` = the bill claims MORE than the source. */
  delta_cents: number;
  bill_total_cents: number;
  expected_cents: number;
  /** Human label of the document we compared against ("PO-1081", "RCP-1134"…). */
  source_label: string;
  /**
   * Commission only. `implied_base_cents` = the goods value the AGENT must have
   * used (`commission / rate`); `source_total_cents` = what our goods bill says.
   * The gap between these two is the story the operator needs to see.
   */
  implied_base_cents?: number;
  source_total_cents?: number;
  /**
   * True when this bill is already paid by a CONFIRMED wire — the money is gone,
   * so the fix is a credit note, never an edit (the PATCH routes refuse it).
   */
  on_confirmed_wire: boolean;
  lines: BillDriftLine[];
}

export interface DriftSettings {
  agent_commission_rate_bps: number;
  commission_tolerance_cents: number;
}

export const DEFAULT_DRIFT_SETTINGS: DriftSettings = {
  agent_commission_rate_bps: 1500,
  commission_tolerance_cents: 10,
};

export interface PgConn {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface BillRow {
  id: string;
  number: string | null;
  status: string;
  bill_type: string;
  purchase_order_id: string | null;
  purchase_order_receipt_id: string | null;
  service_vendor_bill_id: string | null;
  freight_vendor_bill_id: string | null;
  freight_amount_cents: number | null;
  po_number: string | null;
  receipt_number: string | null;
  total_cents: number | string;
  on_confirmed_wire: boolean;
  is_agent_vendor: boolean;
}

interface LineRow {
  vendor_bill_id: string;
  purchase_order_line_id: string | null;
  receipt_line_id: string | null;
  sku: string | null;
  qty: number | string;
  unit_cost_cents: number | string;
}

interface SourceLineRow {
  key_id: string;
  parent_id: string;
  sku: string | null;
  qty: number | string;
  unit_cost_cents: number | string | null;
}

/** pg returns `bigint`/`numeric` aggregates as strings — never trust the type. */
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

async function rows<T>(db: PgConn, sql: string, b?: unknown[]): Promise<T[]> {
  const r = await db.raw(sql, b);
  return r.rows as T[];
}

export async function loadDriftSettings(db: PgConn): Promise<DriftSettings> {
  const r = await rows<Partial<DriftSettings>>(
    db,
    `SELECT agent_commission_rate_bps, commission_tolerance_cents
       FROM china_finance_settings WHERE id = 'singleton'`
  ).catch(() => []);
  const s = r[0];
  return {
    agent_commission_rate_bps: num(
      s?.agent_commission_rate_bps ?? DEFAULT_DRIFT_SETTINGS.agent_commission_rate_bps
    ),
    commission_tolerance_cents: num(
      s?.commission_tolerance_cents ?? DEFAULT_DRIFT_SETTINGS.commission_tolerance_cents
    ),
  };
}

/**
 * Compute drift for a set of vendor bills. Pass `vendorBillIds` to scope it to
 * the page you are rendering — the China Finance ledger enriches only the rows
 * it already loaded, never the whole table.
 */
export async function loadBillDrift(
  db: PgConn,
  opts: { vendorBillIds?: string[]; vendorId?: string; settings?: DriftSettings }
): Promise<Map<string, BillDrift>> {
  const ids = opts.vendorBillIds;
  if (ids && ids.length === 0) return new Map();
  const settings = opts.settings ?? (await loadDriftSettings(db));

  const scope: string[] = [];
  const bind: unknown[] = [];
  if (ids) {
    scope.push(`vb.id = ANY(?)`);
    bind.push(ids);
  }
  if (opts.vendorId) {
    scope.push(`vb.vendor_id = ?`);
    bind.push(opts.vendorId);
  }
  if (scope.length === 0) return new Map();

  const bills = await rows<BillRow>(
    db,
    `SELECT vb.id, vb.number, vb.status, vb.bill_type,
            vb.purchase_order_id, vb.purchase_order_receipt_id,
            vb.service_vendor_bill_id, vb.freight_vendor_bill_id,
            vb.freight_amount_cents,
            po.number AS po_number,
            r.number  AS receipt_number,
            -- Excludes freight charge lines (§7 — a flat non-landed ExpenseLine
            -- added directly to a regular bill): they carry real money owed
            -- (decision D9, included in recomputeBillFinanceLinks' total) but
            -- are NOT part of the goods/commission comparison this total feeds
            -- below — including them would fabricate commission drift on any
            -- China regular bill that also has a freight charge line.
            COALESCE((SELECT SUM(l.unit_cost_cents::bigint * l.qty)::bigint
                        FROM vendor_bill_line l
                       WHERE l.vendor_bill_id = vb.id AND l.deleted_at IS NULL
                         AND COALESCE(l.line_kind, '') <> 'freight_charge'), 0) AS total_cents,
            EXISTS (SELECT 1
                      FROM china_finance_bill cfb
                      JOIN china_wire_transfer_application a ON a.bill_id = cfb.id
                      JOIN china_wire_transfer w ON w.id = a.wire_transfer_id
                     WHERE cfb.vendor_bill_id = vb.id AND w.status = 'confirmed') AS on_confirmed_wire,
            COALESCE(qv.metadata @> '{"is_china_agent":true}'::jsonb
                     OR lower(qv.metadata->>'is_china_agent') = 'true', false) AS is_agent_vendor
       FROM vendor_bill vb
       LEFT JOIN qb_vendor qv ON qv.id = vb.vendor_id
       LEFT JOIN purchase_order po ON po.id = vb.purchase_order_id
       LEFT JOIN purchase_order_receipt r ON r.id = vb.purchase_order_receipt_id
      WHERE vb.deleted_at IS NULL
        AND vb.bill_type IN ('regular','service','freight')
        AND (${scope.join(" AND ")})`,
    bind
  );
  if (bills.length === 0) return new Map();

  // A service/freight bill is reconciled against its PARENT regular bill, which
  // may not itself be in scope (China Finance can render the sibling rows apart).
  const needParents = bills.some((b) => b.bill_type !== "regular");

  const parents = needParents
    ? await rows<{
        id: string;
        number: string | null;
        service_vendor_bill_id: string | null;
        freight_vendor_bill_id: string | null;
        freight_amount_cents: number | null;
        total_cents: number | string;
      }>(
        db,
        `SELECT vb.id, vb.number, vb.service_vendor_bill_id, vb.freight_vendor_bill_id,
                vb.freight_amount_cents,
                -- Same freight_charge exclusion as the main bills query above —
                -- this is the "goods" total the commission reconciliation inverts.
                COALESCE((SELECT SUM(l.unit_cost_cents::bigint * l.qty)::bigint
                            FROM vendor_bill_line l
                           WHERE l.vendor_bill_id = vb.id AND l.deleted_at IS NULL
                             AND COALESCE(l.line_kind, '') <> 'freight_charge'), 0) AS total_cents
           FROM vendor_bill vb
          WHERE vb.deleted_at IS NULL
            AND vb.bill_type = 'regular'
            AND (vb.service_vendor_bill_id = ANY(?) OR vb.freight_vendor_bill_id = ANY(?))`,
        [bills.map((b) => b.id), bills.map((b) => b.id)]
      )
    : [];

  const parentOfService = new Map<string, (typeof parents)[number]>();
  const parentOfFreight = new Map<string, (typeof parents)[number]>();
  for (const p of parents) {
    if (p.service_vendor_bill_id) parentOfService.set(p.service_vendor_bill_id, p);
    if (p.freight_vendor_bill_id) parentOfFreight.set(p.freight_vendor_bill_id, p);
  }

  // ── Line-based rules (regular bills only) ──────────────────────────────────
  const regularIds = bills
    .filter((b) => b.bill_type === "regular" && b.purchase_order_id)
    .map((b) => b.id);

  const billLines = regularIds.length
    ? await rows<LineRow>(
        db,
        `SELECT l.vendor_bill_id, l.purchase_order_line_id, l.receipt_line_id,
                l.sku, l.qty, l.unit_cost_cents
           FROM vendor_bill_line l
          WHERE l.vendor_bill_id = ANY(?)
            AND l.deleted_at IS NULL
            AND COALESCE(l.line_type,'product') = 'product'`,
        [regularIds]
      )
    : [];

  const poIds = Array.from(
    new Set(
      bills
        .filter((b) => b.bill_type === "regular" && b.purchase_order_id)
        .map((b) => b.purchase_order_id as string)
    )
  );
  const poLines = poIds.length
    ? await rows<SourceLineRow>(
        db,
        `SELECT pol.id AS key_id, pol.purchase_order_id AS parent_id,
                pol.sku_snapshot AS sku,
                GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0) AS qty,
                COALESCE(pol.unit_cost_cents,0) AS unit_cost_cents
           FROM purchase_order_line pol
          WHERE pol.purchase_order_id = ANY(?)
            AND pol.deleted_at IS NULL
            AND COALESCE(pol.status,'open') <> 'cancelled'
            AND GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0) > 0`,
        [poIds]
      )
    : [];

  // A receipt-pinned bill is compared against EVERYTHING received on its PO, not
  // just the pinned receipt. A PO's goods can arrive across several receipts
  // while the commercial invoice still covers the whole order — verified against
  // the live data: every Veetech PO has exactly ONE regular bill, even the ones
  // with two receipts, so aggregating cannot double-count. Scoping to the single
  // pinned receipt made VB-1004 look $111.50 short when its quantities are exact.
  const pinnedPoIds = Array.from(
    new Set(
      bills
        .filter((b) => b.purchase_order_receipt_id && b.purchase_order_id)
        .map((b) => b.purchase_order_id as string)
    )
  );
  const receiptLines = pinnedPoIds.length
    ? await rows<SourceLineRow>(
        db,
        `SELECT MIN(rl.id) AS key_id,
                r.purchase_order_id AS parent_id,
                rl.sku_snapshot AS sku,
                SUM(rl.qty_received_now)::bigint AS qty,
                MAX(rl.unit_cost_cents_override) AS unit_cost_cents
           FROM purchase_order_receipt_line rl
           JOIN purchase_order_receipt r ON r.id = rl.purchase_order_receipt_id
          WHERE r.purchase_order_id = ANY(?)
            AND rl.deleted_at IS NULL
            AND r.deleted_at IS NULL
            AND r.status IN ('applied','synced')
          GROUP BY r.purchase_order_id, rl.sku_snapshot`,
        [pinnedPoIds]
      )
    : [];

  // How the received side is labelled, and whether it spans several receipts.
  const receiptMeta = pinnedPoIds.length
    ? await rows<{ purchase_order_id: string; n: number | string; numbers: string }>(
        db,
        `SELECT r.purchase_order_id, COUNT(*)::int AS n,
                STRING_AGG(r.number, ', ' ORDER BY r.number) AS numbers
           FROM purchase_order_receipt r
          WHERE r.purchase_order_id = ANY(?)
            AND r.deleted_at IS NULL
            AND r.status IN ('applied','synced')
          GROUP BY r.purchase_order_id`,
        [pinnedPoIds]
      )
    : [];
  const receiptLabelByPo = new Map(
    receiptMeta.map((m) => [m.purchase_order_id, m.numbers ?? "the receipts"])
  );

  // D6 multi-receipt: a bill can be BOUND to a subset of its PO's receipts
  // (purchase_order_receipt.vendor_bill_id). Such a bill legitimately covers
  // only ITS receipts — comparing it against the PO-wide union would flag every
  // partial bill as "missing" the other bills' receipts (bug seen live on
  // VB-1066). We aggregate a second, per-BILL source and treat a bill as in
  // sync when it matches EITHER its bound set OR the PO-wide union ("match
  // either"): legacy whole-PO bills (backfilled with a single bound receipt)
  // still match the PO-wide side — scoping them to their one bound receipt
  // would reintroduce the VB-1004 false positive this file already fixed.
  const regularBillIds = bills
    .filter((b) => b.bill_type === "regular" && b.purchase_order_id)
    .map((b) => b.id);
  const boundReceiptLines = regularBillIds.length
    ? await rows<SourceLineRow>(
        db,
        `SELECT MIN(rl.id) AS key_id,
                r.vendor_bill_id AS parent_id,
                rl.sku_snapshot AS sku,
                SUM(rl.qty_received_now)::bigint AS qty,
                MAX(rl.unit_cost_cents_override) AS unit_cost_cents
           FROM purchase_order_receipt_line rl
           JOIN purchase_order_receipt r ON r.id = rl.purchase_order_receipt_id
          WHERE r.vendor_bill_id = ANY(?)
            AND rl.deleted_at IS NULL
            AND r.deleted_at IS NULL
            AND r.status IN ('applied','synced')
          GROUP BY r.vendor_bill_id, rl.sku_snapshot`,
        [regularBillIds]
      )
    : [];
  const boundReceiptLabels = regularBillIds.length
    ? await rows<{ vendor_bill_id: string; numbers: string }>(
        db,
        `SELECT r.vendor_bill_id,
                STRING_AGG(r.number, ', ' ORDER BY r.number) AS numbers
           FROM purchase_order_receipt r
          WHERE r.vendor_bill_id = ANY(?)
            AND r.deleted_at IS NULL
            AND r.status IN ('applied','synced')
          GROUP BY r.vendor_bill_id`,
        [regularBillIds]
      )
    : [];
  const boundLabelByBill = new Map(
    boundReceiptLabels.map((m) => [m.vendor_bill_id, m.numbers])
  );

  const linesByBill = new Map<string, LineRow[]>();
  for (const l of billLines) {
    const arr = linesByBill.get(l.vendor_bill_id);
    if (arr) arr.push(l);
    else linesByBill.set(l.vendor_bill_id, [l]);
  }
  const groupByParent = (src: SourceLineRow[]): Map<string, SourceLineRow[]> => {
    const m = new Map<string, SourceLineRow[]>();
    for (const s of src) {
      const arr = m.get(s.parent_id);
      if (arr) arr.push(s);
      else m.set(s.parent_id, [s]);
    }
    return m;
  };
  const poByOrder = groupByParent(poLines);
  // Both are keyed by purchase_order_id — the received side is aggregated per SKU
  // across every applied receipt on the order.
  const rcByOrder = groupByParent(receiptLines);
  // Keyed by vendor_bill_id — only the receipts BOUND to that bill (D6).
  const rcByBill = groupByParent(boundReceiptLines);

  const out = new Map<string, BillDrift>();

  for (const b of bills) {
    const billTotal = num(b.total_cents);

    // ── regular → PO or RECEIPT ────────────────────────────────────────────
    if (b.bill_type === "regular" && b.purchase_order_id) {
      const pinned = !!b.purchase_order_receipt_id;
      /**
       * Compares the bill's lines against ONE source line set and returns the
       * drift lines (empty = in sync with that source).
       *
       * Matching: against receipts the received side is aggregated PER SKU, so
       * SKU is the key (a bill line's receipt_line_id points at one specific
       * receipt line — unusable against an aggregate). Against a PO the line FK
       * is authoritative, with SKU as the fallback for a line whose PO line was
       * replaced. A consumed source line is never matched twice.
       */
      const compareAgainst = (
        source: SourceLineRow[],
        bySkuOnly: boolean
      ): BillDriftLine[] => {
        const srcById = new Map<string, SourceLineRow>();
        const srcBySku = new Map<string, SourceLineRow>();
        for (const s of source) {
          srcById.set(s.key_id, s);
          if (s.sku && !srcBySku.has(s.sku)) srcBySku.set(s.sku, s);
        }
        const drift: BillDriftLine[] = [];
        const seen = new Set<string>();
        const resolve = (l: LineRow): SourceLineRow | undefined => {
          if (bySkuOnly) return l.sku ? srcBySku.get(l.sku) : undefined;
          const byFk = l.purchase_order_line_id
            ? srcById.get(l.purchase_order_line_id)
            : undefined;
          if (byFk && !seen.has(byFk.key_id)) return byFk;
          const bySku = l.sku ? srcBySku.get(l.sku) : undefined;
          if (bySku && !seen.has(bySku.key_id)) return bySku;
          return byFk ?? bySku;
        };
        for (const l of linesByBill.get(b.id) ?? []) {
          const s = resolve(l);
          if (s) seen.add(s.key_id);
          const billQty = num(l.qty);
          const srcQty = s ? num(s.qty) : 0;
          const cost = num(l.unit_cost_cents);
          const srcCost =
            s?.unit_cost_cents == null ? cost : num(s.unit_cost_cents);
          if (billQty !== srcQty || cost !== srcCost) {
            drift.push({
              sku: l.sku ?? "",
              bill_qty: billQty,
              source_qty: srcQty,
              unit_cost_cents: cost,
              delta_cents: billQty * cost - srcQty * srcCost,
            });
          }
        }
        // Source lines the bill is missing entirely.
        for (const s of source) {
          if (seen.has(s.key_id)) continue;
          const srcQty = num(s.qty);
          const srcCost = num(s.unit_cost_cents);
          drift.push({
            sku: s.sku ?? "",
            bill_qty: 0,
            source_qty: srcQty,
            unit_cost_cents: srcCost,
            delta_cents: -(srcQty * srcCost),
          });
        }
        return drift;
      };

      // "Match either" (D6): in sync when the bill matches its BOUND receipt
      // set (partial bill) OR the PO-wide union (legacy whole-PO bill) — see
      // the aggregation comment above for why both sides are needed.
      const boundSource = rcByBill.get(b.id);
      let driftLines: BillDriftLine[];
      let sourceLabel: string | null | undefined;
      if (pinned || boundSource) {
        const boundDrift = boundSource
          ? compareAgainst(boundSource, true)
          : null;
        if (boundDrift && boundDrift.length === 0) {
          driftLines = [];
          sourceLabel = boundLabelByBill.get(b.id);
        } else {
          const poWideDrift = compareAgainst(
            rcByOrder.get(b.purchase_order_id) ?? [],
            true
          );
          if (poWideDrift.length === 0) {
            driftLines = [];
            sourceLabel = receiptLabelByPo.get(b.purchase_order_id);
          } else {
            // Both drift → report the more precise (bound) side when it exists.
            driftLines = boundDrift ?? poWideDrift;
            sourceLabel = boundDrift
              ? (boundLabelByBill.get(b.id) ?? b.receipt_number)
              : (receiptLabelByPo.get(b.purchase_order_id) ?? b.receipt_number);
          }
        }
      } else {
        driftLines = compareAgainst(
          poByOrder.get(b.purchase_order_id) ?? [],
          false
        );
        sourceLabel = b.po_number;
      }

      if (driftLines.length > 0) {
        const delta = driftLines.reduce((n, l) => n + l.delta_cents, 0);
        out.set(b.id, {
          vendor_bill_id: b.id,
          vendor_bill_number: b.number,
          kind: pinned || rcByBill.has(b.id) ? "receipt_lines" : "po_lines",
          delta_cents: delta,
          bill_total_cents: billTotal,
          expected_cents: billTotal - delta,
          source_label: sourceLabel ?? "source",
          on_confirmed_wire: !!b.on_confirmed_wire,
          lines: driftLines,
        });
      }
      continue;
    }

    // ── service → reconcile the agent's commission against the goods bill ──
    // AGENT vendors only (flag read LIVE from qb_vendor, never a snapshot): the
    // implied-base inversion assumes the agent's percentage commission model; a
    // regular vendor's service bill has no such relationship to reconcile.
    if (b.bill_type === "service") {
      if (!b.is_agent_vendor) continue;
      const parent = parentOfService.get(b.id);
      if (!parent) continue;
      const rate = settings.agent_commission_rate_bps / 10_000;
      if (rate <= 0) continue;
      const goods = num(parent.total_cents);
      const expected = Math.round(goods * rate);
      const delta = billTotal - expected;
      if (Math.abs(delta) > settings.commission_tolerance_cents) {
        out.set(b.id, {
          vendor_bill_id: b.id,
          vendor_bill_number: b.number,
          kind: "commission",
          delta_cents: delta,
          bill_total_cents: billTotal,
          expected_cents: expected,
          implied_base_cents: Math.round(billTotal / rate),
          source_total_cents: goods,
          source_label: parent.number ?? "goods bill",
          on_confirmed_wire: !!b.on_confirmed_wire,
          lines: [],
        });
      }
      continue;
    }

    // ── freight → declared on the regular bill vs the freight bill total ───
    if (b.bill_type === "freight") {
      const parent = parentOfFreight.get(b.id);
      if (!parent) continue;
      const declared = num(parent.freight_amount_cents);
      const delta = billTotal - declared;
      if (delta !== 0) {
        out.set(b.id, {
          vendor_bill_id: b.id,
          vendor_bill_number: b.number,
          kind: "freight",
          delta_cents: delta,
          bill_total_cents: billTotal,
          expected_cents: declared,
          source_label: parent.number ?? "goods bill",
          on_confirmed_wire: !!b.on_confirmed_wire,
          lines: [],
        });
      }
    }
  }

  return out;
}

/**
 * One-line operator-facing explanation. The REMEDIATION differs per kind, so the
 * sentence names it: a goods bill is fixed with "Update From…", but the agent's
 * commission is a document THEY issue — you request a revised service bill.
 * A bill already paid by a confirmed wire can be fixed by neither: both PATCH
 * routes refuse it, so it needs a credit note.
 */
export function describeDrift(d: BillDrift): string {
  const money = (c: number) =>
    `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
  const gap = money(Math.abs(d.delta_cents));
  const over = d.delta_cents > 0;

  const head =
    d.kind === "commission"
      ? `The agent billed ${money(d.bill_total_cents)} of commission, which implies a goods base of ${money(
          d.implied_base_cents ?? 0
        )} — but ${d.source_label} declares ${money(d.source_total_cents ?? 0)}`
      : d.kind === "freight"
        ? `This freight bill totals ${money(d.bill_total_cents)} but ${d.source_label} declares ${money(d.expected_cents)}`
        : d.delta_cents === 0
          ? // Lines moved but the totals cancel out — typically a SKU that was
            // replaced on the PO while the bill still points at the old one. The
            // money is unchanged, so lead with the LINES, never with "$0.00".
            `${d.lines.length} line${d.lines.length === 1 ? "" : "s"} on this bill no longer match ${d.source_label} (the amounts cancel out, so the total is unchanged)`
          : `This bill ${over ? "claims" : "is missing"} ${gap} ${over ? "more than" : "against"} ${d.source_label}`;

  const fix = d.on_confirmed_wire
    ? d.kind === "commission"
      ? "It is already paid by a confirmed wire — verify with the agent; correcting it under a supervisor PIN turns the difference into a credit."
      : "It is already paid by a confirmed wire — correcting it requires a supervisor PIN, and the difference becomes a credit against the agent."
    : d.kind === "commission"
      ? "Verify the quantities and request a revised service bill from the agent."
      : "Use “Update From…” to bring it back in line.";

  return `${head}. ${fix}`;
}
