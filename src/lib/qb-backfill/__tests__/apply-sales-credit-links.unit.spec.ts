import {
  cmPairKey,
  deriveCreditPaymentStatus,
  negativeInvoiceLinks,
  planCreditMemoApplicationRows,
  type BackfilledCreditMemo,
  type LinkedInvoiceRef,
} from "../apply-sales-credit-links";

function cm(txn: string, links: Array<[string, number, string?]>, over: Partial<BackfilledCreditMemo> = {}): BackfilledCreditMemo {
  return {
    cm_id: `cm_${txn}`, cm_txn_id: txn, cm_ref_number: "CM-9", credit_memo_number: "CM-0009", customer_id: "cus_a",
    total_cents: 1000, cm_date: "2026-01-09",
    linked_txns: links.map(([id, amt, type]) => ({ txn_id: id, txn_type: type ?? "Invoice", txn_date: null, amount_cents: amt, ref_number: `R${id}` })),
    ...over,
  };
}
const inv = (id: string, date: string): LinkedInvoiceRef => ({ invoice_id: `inv_${id}`, invoice_number: `00${id}`, order_id: `order_${id}`, invoice_date: date });
const resolved = new Map<string, LinkedInvoiceRef | null>([["I1", inv("1", "2026-01-05")], ["I2", inv("2", "2026-01-26")], ["I9", null]]);

describe("qb-backfill/apply-sales-credit-links · planner", () => {
  it("sólo los enlaces Invoice con monto NEGATIVO son aplicaciones", () => {
    const c = cm("CM1", [["I1", -700], ["I2", 300], ["X1", -50, "Check"], ["R1", -50, "ARRefundCreditCard"]]);
    expect(negativeInvoiceLinks(c).map((l) => l.txn_id)).toEqual(["I1"]);
  });
  it("planea con |monto| y applied_at = la fecha más tardía de CM y factura", () => {
    const plan = planCreditMemoApplicationRows([cm("CM1", [["I1", -700], ["I2", -120]])], resolved, new Set());
    expect(plan.rows).toEqual([
      { cm_id: "cm_CM1", cm_txn_id: "CM1", customer_id: "cus_a", invoice_txn_id: "I1", invoice_id: "inv_1", invoice_number: "001", order_id: "order_1", amount_cents: 700, applied_at: "2026-01-09" },
      { cm_id: "cm_CM1", cm_txn_id: "CM1", customer_id: "cus_a", invoice_txn_id: "I2", invoice_id: "inv_2", invoice_number: "002", order_id: "order_2", amount_cents: 120, applied_at: "2026-01-26" },
    ]);
    expect(plan.unlinked).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });
  it("factura desconocida → unlinked (no bloquea); par existente → already; monto 0 → zero_amount", () => {
    const plan = planCreditMemoApplicationRows(
      [cm("CM1", [["I9", -100], ["I1", -700], ["I2", 0]]), cm("CM2", [["I2", -1]])],
      resolved,
      new Set([cmPairKey("CM1", "inv_1")])
    );
    expect(plan.rows.map((r) => [r.cm_txn_id, r.invoice_id, r.amount_cents])).toEqual([["CM2", "inv_2", 1]]);
    expect(plan.unlinked).toEqual([{ cm_txn_id: "CM1", invoice_txn_id: "I9", invoice_ref_number: "RI9", amount_cents: 100 }]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["already"]);
  });
  it("la suma (incluido lo ya aplicado en un pago reusado) no supera el total del CM → exceeds_credit", () => {
    const plan = planCreditMemoApplicationRows([cm("CM1", [["I1", -600], ["I2", -500]])], resolved, new Set(), new Map([["CM1", 300]]));
    expect(plan.rows.map((r) => r.amount_cents)).toEqual([600]);
    expect(plan.skipped).toEqual([{ cm_txn_id: "CM1", invoice_txn_id: "I2", reason: "exceeds_credit" }]);
  });
  it("status del pago derivado de Σ aplicado vs amount (forma nativa del apply)", () => {
    expect(deriveCreditPaymentStatus(0, 1000)).toBe("available");
    expect(deriveCreditPaymentStatus(400, 1000)).toBe("partially_applied");
    expect(deriveCreditPaymentStatus(1000, 1000)).toBe("applied");
  });
});
