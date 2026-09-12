import { classifySalesLineForCreate, computeSalesTotals, planSalesLines, productLines } from "../sales-lines";
import type { ItemIndex, ItemIndexEntry } from "../resolve";
import type { QbSalesLine } from "../sales-types";

function index(entries: Array<Partial<ItemIndexEntry> & { sku: string }>): ItemIndex {
  const byQbId = new Map<string, ItemIndexEntry>();
  const bySku = new Map<string, ItemIndexEntry>();
  for (const e of entries) {
    const entry: ItemIndexEntry = { variant_id: e.variant_id ?? `variant_${e.sku}`, inventory_item_id: null, sku: e.sku, quickbooks_id: e.quickbooks_id ?? null };
    bySku.set(entry.sku, entry);
    if (entry.quickbooks_id) byQbId.set(entry.quickbooks_id, entry);
  }
  return { byQbId, bySku };
}

function line(overrides: Partial<QbSalesLine> & { name?: string | null }): QbSalesLine {
  const { name, ...rest } = overrides;
  return {
    txn_line_id: "L1",
    item_ref: name === null ? null : { list_id: `id-${name ?? "SKU1"}`, full_name: name ?? "SKU1" },
    description: "desc",
    quantity: 2,
    rate_cents: 500,
    amount_cents: 1000,
    sales_tax_code_ref: null,
    ...rest,
  };
}

const idx = index([{ sku: "SKU1", quickbooks_id: "id-SKU1" }, { sku: "EAP-AR1-8S" }]);

describe("qb-backfill/sales-lines · classifySalesLineForCreate", () => {
  it("producto resuelto por ListID / SKU / último segmento", () => {
    expect(classifySalesLineForCreate(line({}), idx)).toMatchObject({ kind: "product", quantity: 2, unit_price_cents: 500, amount_cents: 1000 });
    const grouped = classifySalesLineForCreate(line({ name: "Channels:EAP-AR1-8S" }), idx);
    expect(grouped.kind).toBe("product");
    expect(grouped.item?.sku).toBe("EAP-AR1-8S");
  });

  it("ítem desconocido → unknown_item (lo crea ensureItem, no bloquea)", () => {
    const c = classifySalesLineForCreate(line({ name: "Special Item", quantity: null, rate_cents: 5000, amount_cents: 5000 }), idx);
    expect(c).toMatchObject({ kind: "unknown_item", item: null, quantity: 1, unit_price_cents: 5000 });
  });

  it("Subtotal y Sales Tax se descartan", () => {
    expect(classifySalesLineForCreate(line({ name: "Subtotal", quantity: null, rate_cents: null, amount_cents: 1000 }), idx).kind).toBe("subtotal");
    expect(classifySalesLineForCreate(line({ name: "Sale Tax 7%", quantity: null, rate_cents: null, amount_cents: 70 }), idx).kind).toBe("sales_tax");
  });

  it("descuento: por nombre o por importe negativo sin cantidad; en 0 es vacío", () => {
    expect(classifySalesLineForCreate(line({ name: "Discount:10%-Promotional Discount", quantity: null, rate_cents: null, amount_cents: -100 }), idx).kind).toBe("discount");
    expect(classifySalesLineForCreate(line({ name: "Restocking Fee", quantity: null, rate_cents: null, amount_cents: -250 }), idx).kind).toBe("discount");
    expect(classifySalesLineForCreate(line({ name: "Discount", quantity: null, rate_cents: null, amount_cents: 0 }), idx).kind).toBe("empty");
  });

  it("envío por prefijo del nombre (shipping/freight/delivery)", () => {
    expect(classifySalesLineForCreate(line({ name: "SHIPPING & HANDLING", quantity: 1, rate_cents: 1500, amount_cents: 1500 }), idx).kind).toBe("shipping");
    expect(classifySalesLineForCreate(line({ name: "Freight", quantity: null, rate_cents: null, amount_cents: 900 }), idx).kind).toBe("shipping");
  });

  it("línea de texto (sin ítem, importe 0) → empty; sin ítem con importe → error", () => {
    expect(classifySalesLineForCreate(line({ name: null, quantity: null, rate_cents: null, amount_cents: 0 }), idx).kind).toBe("empty");
    expect(() => classifySalesLineForCreate(line({ name: null, quantity: null, rate_cents: null, amount_cents: 5 }), idx)).toThrow(/sin ItemRef/);
  });

  it("producto con cantidad 0 e importe 0 → empty (anotado, no vendido)", () => {
    expect(classifySalesLineForCreate(line({ quantity: 0, rate_cents: 2071, amount_cents: 0 }), idx).kind).toBe("empty");
    expect(classifySalesLineForCreate(line({ quantity: 0, rate_cents: 2071, amount_cents: 100 }), idx).kind).toBe("product");
  });

  it("cantidad decimal → error (el POS pide entero)", () => {
    expect(() => classifySalesLineForCreate(line({ quantity: 2.5, amount_cents: 1250 }), idx)).toThrow(/decimal/);
  });

  it("sin Rate: precio unitario = importe / cantidad", () => {
    expect(classifySalesLineForCreate(line({ rate_cents: null, quantity: 4, amount_cents: 1000 }), idx).unit_price_cents).toBe(250);
  });
});

describe("qb-backfill/sales-lines · totales", () => {
  const lines = [
    line({ txn_line_id: "a" }), // producto 1000
    line({ txn_line_id: "b", name: "Special Item", quantity: null, rate_cents: 5000, amount_cents: 5000 }), // unknown 5000
    line({ txn_line_id: "c", name: "Subtotal", quantity: null, rate_cents: null, amount_cents: 6000 }),
    line({ txn_line_id: "d", name: "Discount", quantity: null, rate_cents: null, amount_cents: -600 }),
    line({ txn_line_id: "e", name: "SHIPPING & HANDLING", quantity: 1, rate_cents: 1500, amount_cents: 1500 }),
    line({ txn_line_id: "f", name: null, quantity: null, rate_cents: null, amount_cents: 0 }),
  ];

  it("computeSalesTotals: Σ productos − descuento + envío + impuesto", () => {
    const classified = lines.map((l) => classifySalesLineForCreate(l, idx));
    expect(computeSalesTotals(classified, 483)).toEqual({
      subtotal_cents: 6000,
      discount_cents: 600,
      shipping_cents: 1500,
      tax_cents: 483,
      total_cents: 7383,
    });
    expect(productLines(classified).map((c) => c.line.txn_line_id)).toEqual(["a", "b"]);
  });

  it("planSalesLines: ok cuando cuadra con el header", () => {
    const plan = planSalesLines(lines, idx, 483, 7383);
    expect(plan.ok).toBe(true);
  });

  it("planSalesLines: total_mismatch con los dos números, sin escribir", () => {
    const plan = planSalesLines(lines, idx, 483, 7400);
    expect(plan).toMatchObject({ ok: false, reason: "total_mismatch", computed_cents: 7383, expected_cents: 7400 });
  });

  it("planSalesLines: line_error con el detalle", () => {
    const plan = planSalesLines([line({ quantity: 1.5, amount_cents: 750 })], idx, 0, 750);
    expect(plan).toMatchObject({ ok: false, reason: "line_error" });
    if (!plan.ok && plan.reason === "line_error") expect(plan.detail).toMatch(/decimal/);
  });
});
