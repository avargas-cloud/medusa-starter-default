import { applySales, RollbackRefused, rollbackSales, type SalesClassification } from "../apply-sales";
import type { SalesApplyContext, SalesServices } from "../sales-context";
import type { QueryableDb } from "../resolve";
import type { QbInvoice } from "../sales-types";

function fakeDb(answer: (sql: string, params?: unknown[]) => Record<string, unknown>[]): QueryableDb & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push(sql);
      return { rows: answer(sql, params) };
    },
  };
}

const services = {} as SalesServices;

function ctxWith(client: QueryableDb): SalesApplyContext {
  return {
    client,
    services,
    runId: "run-test",
    itemIndex: { byQbId: new Map(), bySku: new Map() },
    customerIndex: new Map(),
    ensureCustomer: async () => "cus_stub",
    ensureLog: { vendors_created: [], items_created: [] },
    log: () => undefined,
    regionId: "reg",
    salesChannelId: "sc",
    goLiveDate: "2026-04-14",
  };
}

const inv = (txn_id: string): QbInvoice =>
  ({ txn_id, txn_date: "2026-01-05", lines: [], subtotal_cents: 0, sales_tax_total_cents: 0, customer_ref: null } as unknown as QbInvoice);

describe("qb-backfill/apply-sales · dry-run (planning)", () => {
  it("cuenta already por TxnID conocido, respeta limit y no escribe", async () => {
    const db = fakeDb((sql) => (/FROM pos_invoice/.test(sql) ? [{ t: "KNOWN" }] : []));
    const classification: SalesClassification = {
      invoices: { create: [inv("KNOWN"), inv("A"), inv("B"), inv("C")] },
      sales_receipts: { create: [] },
      receive_payments: { create: [] },
      credit_memos: { create: [] },
    };
    const report = await applySales(classification, ctxWith(db), { apply: false, limit: 2, types: ["invoice"] });
    expect(report.invoices).toMatchObject({ already: 1, create: 2, created: [], blocked: [] });
    expect(report.sales_receipts.create).toBe(0);
    expect(db.calls.some((s) => /BEGIN|INSERT|UPDATE/.test(s))).toBe(false);
  });

  it("types restringe qué tipos se recorren", async () => {
    const db = fakeDb(() => []);
    const classification: SalesClassification = {
      invoices: { create: [inv("A")] },
      sales_receipts: { create: [] },
      receive_payments: { create: [] },
      credit_memos: { create: [] },
    };
    const report = await applySales(classification, ctxWith(db), { apply: false, types: ["credit_memo"] });
    expect(report.invoices.create).toBe(0);
    expect(db.calls.some((s) => /step = 'credit_memo'/.test(s))).toBe(true);
    expect(db.calls.some((s) => /BEGIN/.test(s))).toBe(false);
  });
});

describe("qb-backfill/apply-sales · rollbackSales", () => {
  it("se niega si hay una payment_application ajena sobre documentos del run", async () => {
    const db = fakeDb((sql) => (/SELECT pa.id FROM payment_application/.test(sql) ? [{ id: "papp_foreign" }] : []));
    await expect(rollbackSales(db, "run-test")).rejects.toBeInstanceOf(RollbackRefused);
    expect(db.calls.some((s) => /^DELETE/.test(s))).toBe(false);
  });

  it("borra en orden inverso y soft-borra las órdenes por SQL cuando no hay module service", async () => {
    const db = fakeDb((sql) => (/SELECT id FROM "order"/.test(sql) ? [{ id: "order_1" }] : []));
    const counts = await rollbackSales(db, "run-test");
    const deletes = db.calls.filter((s) => /^DELETE FROM (\w+)/.test(s)).map((s) => /^DELETE FROM (\w+)/.exec(s)![1]);
    expect(deletes).toEqual([
      "payment_application",
      "invoice_payment",
      "customer_payment",
      "pos_credit_memo_item",
      "pos_credit_memo",
      "pos_invoice_item",
      "pos_invoice",
      "qb_order_pipeline",
    ]);
    expect(db.calls.some((s) => /UPDATE "order" SET deleted_at/.test(s))).toBe(true);
    expect(counts.orders).toBe(1);
  });
});
