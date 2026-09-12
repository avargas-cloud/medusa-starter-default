import {
  headerFromPosInvoice,
  isQbLineTaxable,
  medusaTaxCents,
  planSalesOrderMoney,
  toMedusaItemMoney,
  type MoneyLineInput,
} from "../sales-order-money";

const L = (key: string, net_cents: number, taxable = true): MoneyLineInput => ({ key, net_cents, taxable });

describe("qb-backfill/sales-order-money · planSalesOrderMoney", () => {
  it("fixture 1 — gravada con descuento: adjustments por línea que suman el descuento, FL @ 7, tax del header", () => {
    // QB: 3 líneas Tax 100.00 + 50.00 + 25.00 = 175.00 · Discount −17.50 · base 157.50 · tax 11.03 (7% redondeado una vez)
    const plan = planSalesOrderMoney([L("a", 10000), L("b", 5000), L("c", 2500)], {
      discount_cents: 1750,
      shipping_cents: 0,
      tax_cents: 1103,
      total_cents: 10000 + 5000 + 2500 - 1750 + 1103,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rate_policy).toBe("statutory");
    expect(plan.tax_rate).toBe(7);
    expect(plan.taxable_base_cents).toBe(15750);
    expect(plan.lines.map((l) => l.adjustment_cents)).toEqual([1000, 500, 250]);
    expect(plan.lines.reduce((s, l) => s + l.adjustment_cents, 0)).toBe(1750);
    for (const l of plan.lines) expect(l.tax_line).toEqual({ code: "FL", rate: 7, description: "Florida Sales Tax" });
    expect(plan.shipping).toBeNull();
    expect(plan.summary).toEqual({ subtotal_cents: 17500, discount_cents: 1750, shipping_cents: 0, tax_cents: 1103, total_cents: 16853 });
    // Lo que Medusa acumula sin redondear cae a ≤ 0.5¢ del header (15750 × 7% = 1102.5 es el peor caso; política ±1¢).
    expect(Math.abs(medusaTaxCents(plan) - 1103)).toBeLessThanOrEqual(0.5);
    // Forma para createOrders: dólares en el borde.
    expect(toMedusaItemMoney(plan.lines[0]!)).toEqual({
      tax_lines: [{ code: "FL", rate: 7, description: "Florida Sales Tax" }],
      adjustments: [{ code: "QB-DISCOUNT", amount: 10, description: "QuickBooks Discount" }],
    });
  });

  it("fixture 2 — exenta: EXEMPT @ 0 en todas, sin adjustments ni shipping, summary con tax 0", () => {
    const plan = planSalesOrderMoney([L("a", 9998, false), L("b", 3400, false)], {
      discount_cents: 0,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: 13398,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rate_policy).toBe("none");
    expect(plan.taxable_base_cents).toBe(0);
    for (const l of plan.lines) {
      expect(l.tax_line).toEqual({ code: "EXEMPT", rate: 0, description: "Tax Exempt" });
      expect(l.adjustment_cents).toBe(0);
      expect(toMedusaItemMoney(l).adjustments).toEqual([]);
    }
    expect(plan.shipping).toBeNull();
    expect(medusaTaxCents(plan)).toBe(0);
  });

  it("fixture 3 — con envío y una línea Non (Invoice 18861: 148.99 · tax 5.25 · total 154.24)", () => {
    // producto 114.99 Tax · servicio 34.00 Non · SHIPPING 0 en este doc; se agrega envío 30.00 Non para cubrir el shipping method.
    const plan = planSalesOrderMoney([L("prod", 11499, true), L("svc", 3400, false)], {
      discount_cents: 0,
      shipping_cents: 3000,
      tax_cents: 805,
      total_cents: 11499 + 3400 + 3000 + 805,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rate_policy).toBe("statutory"); // round(114.99 × 7%) = 8.05
    expect(plan.lines[0]!.tax_line.code).toBe("FL");
    expect(plan.lines[1]!.tax_line).toEqual({ code: "EXEMPT", rate: 0, description: "Tax Exempt" });
    expect(plan.shipping).toEqual({ name: "Shipping", amount_cents: 3000 });
    expect(plan.summary.shipping_cents).toBe(3000);
    expect(Math.abs(medusaTaxCents(plan) - 805)).toBeLessThan(0.5);
  });

  it("tasa efectiva cuando QB gravó un conjunto distinto del que el POS conoce (620.02 con tax 41.99)", () => {
    // pos_invoice_item.taxable = true en todas, pero QB gravó 599.86 (Bank Charges 20.16 era Non).
    const plan = planSalesOrderMoney([L("a", 59986), L("bank", 2016)], {
      discount_cents: 0,
      shipping_cents: 3000,
      tax_cents: 4199,
      total_cents: 59986 + 2016 + 3000 + 4199,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rate_policy).toBe("effective");
    expect(plan.tax_rate).not.toBe(7);
    expect(plan.lines[0]!.tax_line.description).toBe("Florida Sales Tax (qb_effective_rate)");
    // Σ (neto × tasa efectiva) reproduce el header al centavo.
    expect(Math.abs(medusaTaxCents(plan) - 4199)).toBeLessThan(0.01);
  });

  it("tax > 0 sin ninguna línea gravada → se gravan todas (el flag del POS es snapshot, QB manda)", () => {
    const plan = planSalesOrderMoney([L("a", 10000, false)], { discount_cents: 0, shipping_cents: 0, tax_cents: 700, total_cents: 10700 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rate_policy).toBe("statutory");
    expect(plan.lines[0]!.taxable).toBe(true);
    expect(plan.lines[0]!.tax_line.code).toBe("FL");
  });

  it("descuento proporcional con residuo por mayor resto: la suma cierra exacta", () => {
    // 3 líneas iguales, descuento 1.00 → 33/33/34 (mayor resto, desempate por índice)
    const plan = planSalesOrderMoney([L("a", 1000), L("b", 1000), L("c", 1000)], { discount_cents: 100, shipping_cents: 0, tax_cents: 203, total_cents: 3000 - 100 + 203 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.reduce((s, l) => s + l.adjustment_cents, 0)).toBe(100);
    expect(plan.taxable_base_cents).toBe(2900);
  });

  it("refuse-no-guess: total que no cuadra, tax sin base, neto negativo, descuento mayor que las líneas", () => {
    expect(planSalesOrderMoney([L("a", 1000)], { discount_cents: 0, shipping_cents: 0, tax_cents: 70, total_cents: 1071 })).toMatchObject({ ok: false, reason: "total_mismatch" });
    expect(planSalesOrderMoney([], { discount_cents: 0, shipping_cents: 0, tax_cents: 70, total_cents: 70 })).toMatchObject({ ok: false, reason: "tax_without_taxable_base" });
    expect(planSalesOrderMoney([L("a", -5)], { discount_cents: 0, shipping_cents: 0, tax_cents: 0, total_cents: -5 })).toMatchObject({ ok: false, reason: "negative_line" });
    expect(planSalesOrderMoney([L("a", 1000)], { discount_cents: 1500, shipping_cents: 0, tax_cents: 0, total_cents: -500 })).toMatchObject({ ok: false, reason: "discount_exceeds_lines" });
  });

  it("orden vacía sin plata → plan vacío válido (las 10 órdenes de $0 del run)", () => {
    const plan = planSalesOrderMoney([], { discount_cents: 0, shipping_cents: 0, tax_cents: 0, total_cents: 0 });
    expect(plan).toMatchObject({ ok: true, rate_policy: "none", lines: [], shipping: null });
  });
});

describe("qb-backfill/sales-order-money · helpers", () => {
  it("isQbLineTaxable: sólo `Non` exime; ausente o `Tax` = gravable", () => {
    expect(isQbLineTaxable("Tax")).toBe(true);
    expect(isQbLineTaxable("Non")).toBe(false);
    expect(isQbLineTaxable("NON")).toBe(false);
    expect(isQbLineTaxable(null)).toBe(true);
    expect(isQbLineTaxable(undefined)).toBe(true);
  });

  it("headerFromPosInvoice: columnas numeric (string) → cents enteros", () => {
    expect(headerFromPosInvoice({ discount: "7409", shipping: "0", tax: "0", total: "318216" })).toEqual({ discount_cents: 7409, shipping_cents: 0, tax_cents: 0, total_cents: 318216 });
    expect(headerFromPosInvoice({ discount: null, shipping: 3000, tax: "4199.0", total: 69201 })).toEqual({ discount_cents: 0, shipping_cents: 3000, tax_cents: 4199, total_cents: 69201 });
  });
});
