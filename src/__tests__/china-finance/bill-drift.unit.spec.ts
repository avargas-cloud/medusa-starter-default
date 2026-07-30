/**
 * The vendor-bill drift engine, driven through the REAL `loadBillDrift` with a
 * fake connection.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * The drift engine already had a verifier — `verify-china-finance-bill-drift.ts`
 * — and it went 14 pass / 10 fail without anybody noticing. It asserted verdicts
 * about LIVE production bills by number ("VB-1045 is over-billed by $111.50"),
 * so every one of those assertions was a claim about data that other people are
 * allowed to correct. Somebody corrected VB-1045; eight assertions turned red
 * for a reason that had nothing to do with the code. Nobody ran it either: CI
 * runs `test:unit` and `type-check`, and the `verify-*` scripts are a human
 * gate. The engine changed five times in the meantime.
 *
 * So the cases live here, in fixtures nobody can edit in production, and they
 * run on every push. The live script keeps the job it is actually good at:
 * reporting today's drift set and checking invariants that hold on ANY data.
 *
 * WHY THE FAKE CONNECTION AGGREGATES INSTEAD OF RETURNING CANNED ROWS
 *
 * Both defects this file pins down live in the SQL, not in the TypeScript. A
 * stub that answered the receipt query with pre-aggregated rows would pass
 * whether or not the engine still asks for the right aggregation — exactly the
 * silent-aging failure we are trying to end. So the stub holds RAW receipt
 * lines and groups them by whatever key the query it was handed asks for, and
 * only supplies the PO-cost fallback column when the query actually selects it.
 * Revert either half of the fix and the tests below fail.
 *
 * An unrecognised statement THROWS. A new query added to the engine must be
 * taught to this stub deliberately; it can never silently answer `[]`.
 */

import {
  DEFAULT_DRIFT_SETTINGS,
  loadBillDrift,
  type BillDrift,
  type PgConn,
} from "../../lib/china-finance/bill-drift";

// ── Fixture model ───────────────────────────────────────────────────────────

interface FxBill {
  id: string;
  number: string;
  bill_type: "regular" | "service" | "freight";
  status?: string;
  purchase_order_id?: string;
  po_number?: string;
  /** Pins the bill to a receipt (the `receipt_lines` rule). */
  purchase_order_receipt_id?: string;
  receipt_number?: string;
  service_vendor_bill_id?: string;
  freight_vendor_bill_id?: string;
  freight_amount_cents?: number;
  on_confirmed_wire?: boolean;
  is_agent_vendor?: boolean;
}

interface FxBillLine {
  vendor_bill_id: string;
  sku: string;
  qty: number;
  unit_cost_cents: number;
  purchase_order_line_id?: string;
  line_kind?: string;
}

interface FxPoLine {
  id: string;
  purchase_order_id: string;
  sku: string;
  qty: number;
  unit_cost_cents: number;
}

/** One physical receipt line — NOT pre-aggregated. That is the point. */
interface FxReceiptLine {
  purchase_order_id: string;
  receipt_number: string;
  /** The bill this receipt is bound to, when it is bound (D6). */
  vendor_bill_id?: string;
  purchase_order_line_id: string;
  sku: string;
  qty: number;
  unit_cost_cents_override?: number;
}

interface Fx {
  bills: FxBill[];
  billLines?: FxBillLine[];
  poLines?: FxPoLine[];
  receiptLines?: FxReceiptLine[];
}

// ── The fake connection ─────────────────────────────────────────────────────

const flat = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** Goods total: what the engine's own SELECT excludes, we exclude. */
function goodsTotal(fx: Fx, billId: string): number {
  return (fx.billLines ?? [])
    .filter(
      (l) =>
        l.vendor_bill_id === billId &&
        !["freight_charge", "tax_charge"].includes(l.line_kind ?? "")
    )
    .reduce((n, l) => n + l.qty * l.unit_cost_cents, 0);
}

function fakeConn(fx: Fx): PgConn {
  const bills = fx.bills;
  const billLines = fx.billLines ?? [];
  const poLines = fx.poLines ?? [];
  const receiptLines = fx.receiptLines ?? [];

  /**
   * Groups raw receipt lines the way the SQL handed to us says to. If the
   * engine ever goes back to `GROUP BY … sku_snapshot`, two different products
   * sharing a placeholder SKU fuse into one row here too — and the VB-1048 test
   * below fails, which is the whole point of doing it this way.
   */
  const aggregateReceipts = (
    sql: string,
    rows: FxReceiptLine[],
    parentOf: (r: FxReceiptLine) => string
  ): Record<string, unknown>[] => {
    const byPoLine = /group by[^;]*rl\.purchase_order_line_id/i.test(sql);
    const bySku = /group by[^;]*rl\.sku_snapshot/i.test(sql);
    if (!byPoLine && !bySku) {
      throw new Error(
        `Fake connection: receipt source query groups by neither ` +
          `rl.purchase_order_line_id nor rl.sku_snapshot — teach the stub the ` +
          `new key before trusting this suite.\n${flat(sql)}`
      );
    }
    /** Does the query ask the PO for a cost to fall back on? */
    const withFallback = /pol\.unit_cost_cents/i.test(sql);

    const out = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const key = `${parentOf(r)}::${byPoLine ? r.purchase_order_line_id : r.sku}`;
      const prev = out.get(key);
      const poCost =
        poLines.find((p) => p.id === r.purchase_order_line_id)?.unit_cost_cents ??
        null;
      if (prev) {
        prev.qty = Number(prev.qty) + r.qty;
        // MAX() semantics, NULL-tolerant, on both cost columns.
        const ovr = prev.unit_cost_cents as number | null;
        if (r.unit_cost_cents_override != null)
          prev.unit_cost_cents = Math.max(ovr ?? -Infinity, r.unit_cost_cents_override);
        continue;
      }
      out.set(key, {
        key_id: byPoLine ? r.purchase_order_line_id : `agg_${key}`,
        parent_id: parentOf(r),
        sku: r.sku,
        qty: r.qty,
        unit_cost_cents: r.unit_cost_cents_override ?? null,
        ...(withFallback ? { fallback_unit_cost_cents: poCost } : {}),
      });
    }
    return Array.from(out.values());
  };

  return {
    raw: async (sql: string) => {
      const s = flat(sql);
      const rows = (r: unknown[]) => Promise.resolve({ rows: r });

      // 1. settings — absent, so the engine falls to its defaults.
      if (s.includes("china_finance_settings")) return rows([]);

      // 2. the bills in scope (the only query that joins qb_vendor).
      if (s.includes("FROM vendor_bill vb") && s.includes("qb_vendor")) {
        return rows(
          bills.map((b) => ({
            id: b.id,
            number: b.number,
            status: b.status ?? "confirmed",
            bill_type: b.bill_type,
            purchase_order_id: b.purchase_order_id ?? null,
            purchase_order_receipt_id: b.purchase_order_receipt_id ?? null,
            service_vendor_bill_id: b.service_vendor_bill_id ?? null,
            freight_vendor_bill_id: b.freight_vendor_bill_id ?? null,
            freight_amount_cents: b.freight_amount_cents ?? null,
            po_number: b.po_number ?? null,
            receipt_number: b.receipt_number ?? null,
            total_cents: goodsTotal(fx, b.id),
            on_confirmed_wire: !!b.on_confirmed_wire,
            is_agent_vendor: !!b.is_agent_vendor,
          }))
        );
      }

      // 3. the parent regular bill of a service/freight bill.
      if (s.includes("FROM vendor_bill vb") && s.includes("service_vendor_bill_id = ANY")) {
        return rows(
          bills
            .filter((b) => b.bill_type === "regular")
            .map((b) => ({
              id: b.id,
              number: b.number,
              service_vendor_bill_id: b.service_vendor_bill_id ?? null,
              freight_vendor_bill_id: b.freight_vendor_bill_id ?? null,
              freight_amount_cents: b.freight_amount_cents ?? null,
              total_cents: goodsTotal(fx, b.id),
            }))
        );
      }

      // 4. how each active regular bill divides its PO (siblings + severity).
      if (s.includes("LEFT JOIN vendor_bill_line l")) {
        return rows(
          bills
            .filter((b) => b.bill_type === "regular" && b.purchase_order_id)
            .map((b) => ({
              parent_id: b.purchase_order_id,
              vendor_bill_id: b.id,
              number: b.number,
              qty: billLines
                .filter((l) => l.vendor_bill_id === b.id)
                .reduce((n, l) => n + l.qty, 0),
            }))
        );
      }

      // 5. the bills' own product lines.
      if (s.includes("FROM vendor_bill_line l")) {
        return rows(
          billLines
            .filter((l) => (l.line_kind ?? "") === "")
            .map((l) => ({
              vendor_bill_id: l.vendor_bill_id,
              purchase_order_line_id: l.purchase_order_line_id ?? null,
              receipt_line_id: null,
              sku: l.sku,
              qty: l.qty,
              unit_cost_cents: l.unit_cost_cents,
            }))
        );
      }

      // 6. the PO's ordered lines.
      if (s.includes("FROM purchase_order_line pol")) {
        return rows(
          poLines.map((p) => ({
            key_id: p.id,
            parent_id: p.purchase_order_id,
            sku: p.sku,
            qty: p.qty,
            unit_cost_cents: p.unit_cost_cents,
            total_cents: p.qty * p.unit_cost_cents,
          }))
        );
      }

      // 7/9. the received side — PO-wide, or scoped to the receipts BOUND to
      // one bill. Distinguished by which id the query calls `parent_id`.
      if (s.includes("FROM purchase_order_receipt_line rl") && !s.includes("STRING_AGG")) {
        if (s.includes("r.vendor_bill_id AS parent_id")) {
          return rows(
            aggregateReceipts(
              s,
              receiptLines.filter((r) => r.vendor_bill_id),
              (r) => r.vendor_bill_id as string
            )
          );
        }
        if (s.includes("r.purchase_order_id AS parent_id")) {
          return rows(
            aggregateReceipts(s, receiptLines, (r) => r.purchase_order_id)
          );
        }
        throw new Error(`Fake connection: unknown receipt parent.\n${s}`);
      }

      // 8/10. how the received side is labelled.
      if (s.includes("STRING_AGG") && s.includes("purchase_order_receipt")) {
        const label = (list: FxReceiptLine[]) =>
          Array.from(new Set(list.map((r) => r.receipt_number)))
            .sort()
            .join(", ");
        if (s.includes("GROUP BY r.vendor_bill_id")) {
          const out = new Map<string, FxReceiptLine[]>();
          for (const r of receiptLines.filter((r) => r.vendor_bill_id)) {
            const k = r.vendor_bill_id as string;
            out.set(k, [...(out.get(k) ?? []), r]);
          }
          return rows(
            Array.from(out, ([vendor_bill_id, list]) => ({
              vendor_bill_id,
              numbers: label(list),
            }))
          );
        }
        const out = new Map<string, FxReceiptLine[]>();
        for (const r of receiptLines) {
          out.set(r.purchase_order_id, [...(out.get(r.purchase_order_id) ?? []), r]);
        }
        return rows(
          Array.from(out, ([purchase_order_id, list]) => ({
            purchase_order_id,
            n: new Set(list.map((r) => r.receipt_number)).size,
            numbers: label(list),
          }))
        );
      }

      throw new Error(
        `Fake connection: unrecognised statement. The drift engine grew a query ` +
          `this suite does not know about — teach it here rather than letting it ` +
          `answer nothing.\n${s}`
      );
    },
  };
}

const run = async (fx: Fx): Promise<Map<string, BillDrift>> =>
  loadBillDrift(fakeConn(fx), { vendorBillIds: fx.bills.map((b) => b.id) });

// ── Cases ───────────────────────────────────────────────────────────────────

describe("drift vs a receipt: two PO lines sharing a placeholder SKU", () => {
  /**
   * VB-1048's shape. `Sample-Product` is a placeholder: two different samples
   * sit on two different PO lines under the same code. Bill, PO and receipt
   * agree unit for unit — there is nothing to report.
   */
  const fx: Fx = {
    bills: [
      {
        id: "vb_1",
        number: "VB-A",
        bill_type: "regular",
        purchase_order_id: "po_1",
        po_number: "PO-A",
        purchase_order_receipt_id: "por_1",
        receipt_number: "RCP-1",
        on_confirmed_wire: true,
        is_agent_vendor: true,
      },
    ],
    poLines: [
      { id: "pol_a", purchase_order_id: "po_1", sku: "Sample-Product", qty: 1, unit_cost_cents: 1510 },
      { id: "pol_b", purchase_order_id: "po_1", sku: "Sample-Product", qty: 1, unit_cost_cents: 2700 },
    ],
    receiptLines: [
      { purchase_order_id: "po_1", receipt_number: "RCP-1", vendor_bill_id: "vb_1", purchase_order_line_id: "pol_a", sku: "Sample-Product", qty: 1 },
      { purchase_order_id: "po_1", receipt_number: "RCP-1", vendor_bill_id: "vb_1", purchase_order_line_id: "pol_b", sku: "Sample-Product", qty: 1 },
    ],
    billLines: [
      { vendor_bill_id: "vb_1", purchase_order_line_id: "pol_a", sku: "Sample-Product", qty: 1, unit_cost_cents: 1510 },
      { vendor_bill_id: "vb_1", purchase_order_line_id: "pol_b", sku: "Sample-Product", qty: 1, unit_cost_cents: 2700 },
    ],
  };

  it("reports nothing — each bill line answers to its own PO line", async () => {
    const drift = await run(fx);
    expect(Array.from(drift.values())).toEqual([]);
  });

  it("still reports a real shortfall on the same shape", async () => {
    // Same collision, but the bill genuinely under-claims the cheaper sample.
    const short: Fx = {
      ...fx,
      billLines: [
        { vendor_bill_id: "vb_1", purchase_order_line_id: "pol_b", sku: "Sample-Product", qty: 1, unit_cost_cents: 2700 },
      ],
    };
    const d = (await run(short)).get("vb_1");
    expect(d?.delta_cents).toBe(-1510);
    expect(d?.lines).toEqual([
      expect.objectContaining({ sku: "Sample-Product", bill_qty: 0, source_qty: 1, unit_cost_cents: 1510 }),
    ]);
  });
});

describe("a source line the bill does not carry", () => {
  /**
   * VB-1053's shape. `unit_cost_cents_override` is optional by design — null
   * means "use the PO line's cost unchanged" — and unset on every receipt line
   * in production. Reading it alone valued the missing line at $0.00, so a real
   * $11.78 shortfall on a wire-paid bill rendered as "the amounts cancel out".
   */
  const fx: Fx = {
    bills: [
      {
        id: "vb_1",
        number: "VB-A",
        bill_type: "regular",
        purchase_order_id: "po_1",
        po_number: "PO-A",
        purchase_order_receipt_id: "por_1",
        receipt_number: "RCP-1",
        on_confirmed_wire: true,
        is_agent_vendor: true,
      },
    ],
    poLines: [
      { id: "pol_a", purchase_order_id: "po_1", sku: "WIDGET", qty: 10, unit_cost_cents: 500 },
      { id: "pol_b", purchase_order_id: "po_1", sku: "LATE-ADD", qty: 1, unit_cost_cents: 1178 },
    ],
    receiptLines: [
      { purchase_order_id: "po_1", receipt_number: "RCP-1", vendor_bill_id: "vb_1", purchase_order_line_id: "pol_a", sku: "WIDGET", qty: 10 },
      { purchase_order_id: "po_1", receipt_number: "RCP-2", vendor_bill_id: "vb_1", purchase_order_line_id: "pol_b", sku: "LATE-ADD", qty: 1 },
    ],
    billLines: [
      { vendor_bill_id: "vb_1", purchase_order_line_id: "pol_a", sku: "WIDGET", qty: 10, unit_cost_cents: 500 },
    ],
  };

  it("is valued at the PO's unit cost, never at zero", async () => {
    const d = (await run(fx)).get("vb_1");
    expect(d?.delta_cents).toBe(-1178);
    expect(d?.lines).toEqual([
      expect.objectContaining({ sku: "LATE-ADD", bill_qty: 0, source_qty: 1, unit_cost_cents: 1178, delta_cents: -1178 }),
    ]);
  });

  it("does not pass itself off as a net-zero swap", async () => {
    const d = (await run(fx)).get("vb_1");
    expect(d?.delta_cents).not.toBe(0);
    expect(d?.severity).toBe("warning");
  });

  it("prefers the receipt's own override when there is one", async () => {
    const withOverride: Fx = {
      ...fx,
      receiptLines: fx.receiptLines!.map((r) =>
        r.purchase_order_line_id === "pol_b" ? { ...r, unit_cost_cents_override: 900 } : r
      ),
    };
    expect((await run(withOverride)).get("vb_1")?.delta_cents).toBe(-900);
  });
});

describe("a bill that claims more than was received", () => {
  /** VB-1045's shape, the case the receipt-pinned rule was written for. */
  it("is flagged against the receipt, over-billed and payable-aware", async () => {
    const d = (
      await run({
        bills: [
          {
            id: "vb_1",
            number: "VB-A",
            bill_type: "regular",
            purchase_order_id: "po_1",
            po_number: "PO-A",
            purchase_order_receipt_id: "por_1",
            receipt_number: "RCP-1",
            on_confirmed_wire: true,
            is_agent_vendor: true,
          },
        ],
        poLines: [{ id: "pol_a", purchase_order_id: "po_1", sku: "EAP-RM5-8S", qty: 50, unit_cost_cents: 446 }],
        receiptLines: [
          { purchase_order_id: "po_1", receipt_number: "RCP-1", vendor_bill_id: "vb_1", purchase_order_line_id: "pol_a", sku: "EAP-RM5-8S", qty: 25 },
        ],
        billLines: [
          { vendor_bill_id: "vb_1", purchase_order_line_id: "pol_a", sku: "EAP-RM5-8S", qty: 50, unit_cost_cents: 446 },
        ],
      })
    ).get("vb_1");

    expect(d?.kind).toBe("receipt_lines");
    expect(d?.delta_cents).toBe(11150);
    expect(d?.severity).toBe("warning");
    expect(d?.on_confirmed_wire).toBe(true);
    expect(d?.lines[0]?.sku).toBe("EAP-RM5-8S");
  });
});

describe("the agent's commission", () => {
  const commissionFx = (goodsQty: number, commissionCents: number): Fx => ({
    bills: [
      {
        id: "vb_goods",
        number: "VB-G",
        bill_type: "regular",
        purchase_order_id: "po_1",
        po_number: "PO-A",
        service_vendor_bill_id: "vb_svc",
        is_agent_vendor: true,
      },
      { id: "vb_svc", number: "VB-S", bill_type: "service", is_agent_vendor: true },
    ],
    poLines: [{ id: "pol_a", purchase_order_id: "po_1", sku: "W", qty: goodsQty, unit_cost_cents: 100 }],
    billLines: [
      { vendor_bill_id: "vb_goods", purchase_order_line_id: "pol_a", sku: "W", qty: goodsQty, unit_cost_cents: 100 },
      { vendor_bill_id: "vb_svc", sku: "Commission", qty: 1, unit_cost_cents: commissionCents },
    ],
  });

  it("tolerates the agent's own cent-level rounding", async () => {
    // 1000 units × $1.00 = $1,000.00 goods → $150.00 expected, billed $150.08.
    const drift = await run(commissionFx(1000, 15008));
    expect(drift.get("vb_svc")).toBeUndefined();
    expect(DEFAULT_DRIFT_SETTINGS.commission_tolerance_cents).toBe(10);
  });

  it("flags a gap past the tolerance and shows the base the agent must have used", async () => {
    const d = (await run(commissionFx(1000, 15176))).get("vb_svc");
    expect(d?.kind).toBe("commission");
    expect(d?.delta_cents).toBe(176);
    expect(d?.implied_base_cents).toBe(101173); // 15176 / 0.15
    expect(d?.source_total_cents).toBe(100000);
  });

  it("leaves a NON-agent vendor's service bill alone", async () => {
    const fx = commissionFx(1000, 15176);
    const drift = await run({
      ...fx,
      bills: fx.bills.map((b) => ({ ...b, is_agent_vendor: false })),
    });
    expect(drift.get("vb_svc")).toBeUndefined();
  });
});

describe("a regular bill with no receipts that covers part of its PO", () => {
  /**
   * The `info` rule: how a vendor splits a shipment is the vendor's decision,
   * so covering part of the order is the expected shape of a partial invoice,
   * not a defect. Claiming MORE than the order stays a warning.
   */
  const partial = (billQty: number): Fx => ({
    bills: [
      { id: "vb_1", number: "VB-A", bill_type: "regular", status: "draft", purchase_order_id: "po_1", po_number: "PO-A" },
      { id: "vb_2", number: "VB-B", bill_type: "regular", status: "draft", purchase_order_id: "po_1", po_number: "PO-A" },
    ],
    poLines: [{ id: "pol_a", purchase_order_id: "po_1", sku: "W", qty: 10, unit_cost_cents: 100 }],
    billLines: [
      { vendor_bill_id: "vb_1", purchase_order_line_id: "pol_a", sku: "W", qty: billQty, unit_cost_cents: 100 },
      { vendor_bill_id: "vb_2", purchase_order_line_id: "pol_a", sku: "W", qty: 3, unit_cost_cents: 100 },
    ],
  });

  it("is informative, and names the sibling holding the rest", async () => {
    const d = (await run(partial(2))).get("vb_1");
    expect(d?.severity).toBe("info");
    expect(d?.po_qty).toBe(10);
    expect(d?.bill_qty).toBe(2);
    expect(d?.siblings).toEqual([{ number: "VB-B", qty: 3 }]);
  });

  it("goes back to a warning when the bill claims MORE than the order", async () => {
    expect((await run(partial(12))).get("vb_1")?.severity).toBe("warning");
  });
});
