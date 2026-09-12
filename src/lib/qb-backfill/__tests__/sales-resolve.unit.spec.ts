import {
  loadCustomerIndex,
  resolveCustomerRef,
  loadKnownSalesTxnIds,
  ensureCustomer,
  newSalesEnsureLog,
  classifySalesLine,
} from "../sales-resolve";
import type { QueryableDb } from "../resolve";
import type { ItemIndex } from "../resolve";
import type { QbSalesLine } from "../sales-types";

function fakeDb(rows: Record<string, unknown>[]): QueryableDb {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

function line(overrides: Partial<QbSalesLine> = {}): QbSalesLine {
  return {
    txn_line_id: "L1",
    item_ref: { list_id: "I1", full_name: "SKU1" },
    description: null,
    quantity: 1,
    rate_cents: 1000,
    amount_cents: 1000,
    sales_tax_code_ref: null,
    ...overrides,
  };
}

describe("qb-backfill/sales-resolve", () => {
  describe("loadCustomerIndex / resolveCustomerRef", () => {
    it("keyea por qb_list_id cuando existe", async () => {
      const db = fakeDb([{ id: "cus_1", email: "a@b.com", qb_list_id: "800011", name: "ACME" }]);
      const idx = await loadCustomerIndex(db);
      expect(idx.byListId.get("800011")).toEqual({ id: "cus_1", email: "a@b.com", name: "ACME" });
      expect(idx.byName.size).toBe(0);
    });

    it("cae a nombre normalizado cuando no hay qb_list_id", async () => {
      const db = fakeDb([{ id: "cus_2", email: null, qb_list_id: null, name: "  John Doe " }]);
      const idx = await loadCustomerIndex(db);
      expect(idx.byName.get("john doe")?.id).toBe("cus_2");
      expect(idx.byListId.size).toBe(0);
    });

    it("resolveCustomerRef: ListID primero", () => {
      const idx = { byListId: new Map([["L1", { id: "cus_1", email: null, name: "ACME" }]]), byName: new Map() };
      expect(resolveCustomerRef(idx, { list_id: "L1", full_name: "whatever" })).toEqual({ id: "cus_1", how: "list_id" });
    });

    it("resolveCustomerRef: fallback a nombre normalizado", () => {
      const idx = { byListId: new Map(), byName: new Map([["acme corp", { id: "cus_3", email: null, name: "ACME Corp" }]]) };
      expect(resolveCustomerRef(idx, { list_id: "ausente", full_name: " ACME Corp " })).toEqual({ id: "cus_3", how: "name" });
    });

    it("resolveCustomerRef: null cuando no resuelve por ningún camino", () => {
      expect(resolveCustomerRef({ byListId: new Map(), byName: new Map() }, { list_id: "x", full_name: "y" })).toBeNull();
    });

    it("resolveCustomerRef: null cuando el ref es null", () => {
      expect(resolveCustomerRef({ byListId: new Map(), byName: new Map() }, null)).toBeNull();
    });
  });

  describe("loadKnownSalesTxnIds", () => {
    it("agrega los 4 sets con una fila cada uno", async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ t: "INV1" }] })
        .mockResolvedValueOnce({ rows: [{ t: "SR1" }] })
        .mockResolvedValueOnce({ rows: [{ t: "PAY1" }] })
        .mockResolvedValueOnce({ rows: [{ t: "CM1" }] });
      const db: QueryableDb = { query };
      const known = await loadKnownSalesTxnIds(db);
      expect(known.invoices.has("INV1")).toBe(true);
      expect(known.sales_receipts.has("SR1")).toBe(true);
      expect(known.payments.has("PAY1")).toBe(true);
      expect(known.credit_memos.has("CM1")).toBe(true);
      expect(query).toHaveBeenCalledTimes(4);
    });
  });

  describe("ensureCustomer", () => {
    it("devuelve el id existente sin insertar de nuevo", async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ id: "cus_existing" }] });
      const db: QueryableDb = { query };
      const log = newSalesEnsureLog();
      const id = await ensureCustomer(db, { list_id: "L1", full_name: "ACME" }, "run1", log);
      expect(id).toBe("cus_existing");
      expect(query).toHaveBeenCalledTimes(1);
      expect(log.customers_created).toHaveLength(0);
    });

    it("crea uno nuevo con email sintético y registra en el log", async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // SELECT: no existe
        .mockResolvedValueOnce({ rows: [] }); // INSERT
      const db: QueryableDb = { query };
      const log = newSalesEnsureLog();
      const id = await ensureCustomer(db, { list_id: "800011X", full_name: "New Customer" }, "run1", log);
      expect(id).toMatch(/^cus_/);
      expect(query).toHaveBeenCalledTimes(2);
      const insertCall = query.mock.calls[1];
      expect(insertCall[1][1]).toBe("qb-800011x@backfill.local");
      expect(log.customers_created).toEqual([{ qb_list_id: "800011X", full_name: "New Customer", id }]);
    });
  });

  describe("classifySalesLine", () => {
    const itemIndex: ItemIndex = {
      byQbId: new Map([["I1", { variant_id: "v1", inventory_item_id: "ii1", sku: "SKU1", quickbooks_id: "I1" }]]),
      bySku: new Map(),
    };
    const emptyIndex: ItemIndex = { byQbId: new Map(), bySku: new Map() };

    it("product: resuelve por ítem", () => {
      const l = line();
      expect(classifySalesLine(l, itemIndex).kind).toBe("product");
    });

    it("subtotal: FullName 'Subtotal'", () => {
      const l = line({ item_ref: { list_id: "X", full_name: "Subtotal" }, quantity: null, rate_cents: null, amount_cents: 500 });
      expect(classifySalesLine(l, emptyIndex).kind).toBe("subtotal");
    });

    it("subtotal: FullName con grupo 'Group:Subtotal'", () => {
      const l = line({ item_ref: { list_id: "X", full_name: "Group:Subtotal" }, quantity: null, rate_cents: null, amount_cents: 500 });
      expect(classifySalesLine(l, emptyIndex).kind).toBe("subtotal");
    });

    it("subtotal: sin FullName-match pero monto == runningSum y sin qty/rate", () => {
      const l = line({ item_ref: { list_id: "X", full_name: "Misc" }, quantity: null, rate_cents: null, amount_cents: 1500 });
      expect(classifySalesLine(l, emptyIndex, 1500).kind).toBe("subtotal");
    });

    it("discount: monto negativo sin cantidad", () => {
      const l = line({ item_ref: { list_id: "X", full_name: "Discount" }, quantity: null, rate_cents: null, amount_cents: -500 });
      expect(classifySalesLine(l, emptyIndex).kind).toBe("discount");
    });

    it("shipping: FullName matchea shipping/freight/delivery", () => {
      const l = line({ item_ref: { list_id: "X", full_name: "Freight" }, quantity: null, rate_cents: null, amount_cents: 1200 });
      expect(classifySalesLine(l, emptyIndex).kind).toBe("shipping");
    });

    it("sales_tax: sin cantidad y FullName matchea tax", () => {
      const l = line({ item_ref: { list_id: "X", full_name: "State Sales Tax" }, quantity: null, rate_cents: null, amount_cents: 80 });
      expect(classifySalesLine(l, emptyIndex).kind).toBe("sales_tax");
    });

    it("unknown_item: no matchea nada y el ítem no resuelve", () => {
      const l = line({ item_ref: { list_id: "X", full_name: "ítem raro" } });
      expect(classifySalesLine(l, emptyIndex).kind).toBe("unknown_item");
    });

    it("unknown_item: sin ItemRef y sin monto negativo", () => {
      const l = line({ item_ref: null, quantity: null, rate_cents: null, amount_cents: 300 });
      expect(classifySalesLine(l, emptyIndex).kind).toBe("unknown_item");
    });
  });
});
