/**
 * Order Commissions — calculadora pura (base, cap combinado, montos, devengo).
 *
 * Reglas de negocio: docs/ORDER_COMMISSIONS_PLAN.md §2 y §11.
 * - Base = subtotal de ítems POST-descuento, sin tax ni flete (cents).
 * - Cap COMBINADO en puntos: descuento% (contra subtotal BRUTO) + Σ comisiones%
 *   (contra el neto) ≤ cap. Medido en bps, nunca en dólares.
 * - eligible_at = max(pago completo, última factura + N días corridos).
 */
import {
  checkCombinedCap,
  commissionBaseCents,
  discountBpsOf,
  eligibleAt,
  recipientAmountCents,
  validateRecipients,
} from "../../lib/commissions/calculator";

describe("commissionBaseCents", () => {
  it("resta el descuento del subtotal de ítems (ejemplo canónico del owner)", () => {
    // Subtotal $1.000, descuento 10% → base $900
    expect(commissionBaseCents({ itemSubtotalCents: 100_000, discountCents: 10_000 })).toBe(90_000);
  });

  it("sin descuento la base es el subtotal", () => {
    expect(commissionBaseCents({ itemSubtotalCents: 55_500, discountCents: 0 })).toBe(55_500);
  });

  it("nunca es negativa aunque el descuento supere el subtotal", () => {
    expect(commissionBaseCents({ itemSubtotalCents: 10_000, discountCents: 12_000 })).toBe(0);
  });

  it("subtotal cero → base cero", () => {
    expect(commissionBaseCents({ itemSubtotalCents: 0, discountCents: 0 })).toBe(0);
  });
});

describe("discountBpsOf", () => {
  it("mide el descuento contra el subtotal BRUTO", () => {
    expect(discountBpsOf({ itemSubtotalCents: 100_000, discountCents: 10_000 })).toBe(1000);
  });

  it("redondea al bps más cercano", () => {
    // 333/9999 = 3.3303...% → 333 bps
    expect(discountBpsOf({ itemSubtotalCents: 9_999, discountCents: 333 })).toBe(333);
  });

  it("subtotal cero → 0 bps (no divide por cero)", () => {
    expect(discountBpsOf({ itemSubtotalCents: 0, discountCents: 500 })).toBe(0);
  });
});

describe("checkCombinedCap", () => {
  it("acepta el ejemplo canónico: 10% descuento + 5% + 5% = 20% == cap 20%", () => {
    const r = checkCombinedCap({
      itemSubtotalCents: 100_000,
      discountCents: 10_000,
      recipientPercentsBps: [500, 500],
      capBps: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.discountBps).toBe(1000);
    expect(r.totalCommissionBps).toBe(1000);
    expect(r.combinedBps).toBe(2000);
  });

  it("rechaza cuando la suma pasa el cap", () => {
    const r = checkCombinedCap({
      itemSubtotalCents: 100_000,
      discountCents: 10_000,
      recipientPercentsBps: [500, 500, 100],
      capBps: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.combinedBps).toBe(2100);
  });

  it("sin descuento, una orden admite el cap entero en comisiones", () => {
    const r = checkCombinedCap({
      itemSubtotalCents: 100_000,
      discountCents: 0,
      recipientPercentsBps: [2000],
      capBps: 2000,
    });
    expect(r.ok).toBe(true);
  });
});

describe("recipientAmountCents", () => {
  it("5% de $900 = $45 (ejemplo canónico)", () => {
    expect(recipientAmountCents(90_000, 500)).toBe(4_500);
  });

  it("redondea half-up al cent", () => {
    // 99.999 * 3.33% = 3329.9667¢ → 3330
    expect(recipientAmountCents(99_999, 333)).toBe(3_330);
  });

  it("base cero → monto cero", () => {
    expect(recipientAmountCents(0, 500)).toBe(0);
  });
});

describe("validateRecipients", () => {
  const ok = [
    { customerId: "cus_1", percentBps: 500 },
    { qbVendorId: "80000-123", percentBps: 300 },
  ];

  it("acepta hasta 3 beneficiarios con porcentaje positivo", () => {
    expect(validateRecipients(ok)).toEqual({ ok: true });
  });

  it("rechaza más de 3", () => {
    const four = [...ok, { customerId: "cus_2", percentBps: 100 }, { customerId: "cus_3", percentBps: 100 }];
    const r = validateRecipients(four);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_many_recipients");
  });

  it("rechaza porcentaje cero o negativo", () => {
    const r = validateRecipients([{ customerId: "cus_1", percentBps: 0 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_percent");
  });

  it("rechaza beneficiario sin identidad (ni customer ni vendor)", () => {
    const r = validateRecipients([{ percentBps: 100 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_identity");
  });

  it("rechaza beneficiario repetido (mismo customer)", () => {
    const r = validateRecipients([
      { customerId: "cus_1", percentBps: 100 },
      { customerId: "cus_1", percentBps: 200 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("duplicate_recipient");
  });

  it("rechaza lista vacía", () => {
    const r = validateRecipients([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_recipients");
  });
});

describe("eligibleAt", () => {
  const paid = new Date("2026-08-01T12:00:00Z");
  const invoiced = new Date("2026-07-20T09:00:00Z");

  it("es la más tardía entre pago completo y última factura + espera", () => {
    // factura + 30d = 2026-08-19 > pago 2026-08-01
    expect(eligibleAt(paid, invoiced, 30)?.toISOString()).toBe("2026-08-19T09:00:00.000Z");
  });

  it("cuando el pago llega después de la espera, manda el pago", () => {
    const latePaid = new Date("2026-09-05T00:00:00Z");
    expect(eligibleAt(latePaid, invoiced, 30)?.toISOString()).toBe("2026-09-05T00:00:00.000Z");
  });

  it("sin pago completo no hay fecha", () => {
    expect(eligibleAt(null, invoiced, 30)).toBeNull();
  });

  it("sin factura no hay fecha", () => {
    expect(eligibleAt(paid, null, 30)).toBeNull();
  });

  it("los días son corridos, no hábiles", () => {
    // 2026-07-20 (lunes) + 1 día = martes 21, sin saltear nada
    expect(eligibleAt(new Date("2026-07-01T00:00:00Z"), invoiced, 1)?.toISOString()).toBe(
      "2026-07-21T09:00:00.000Z"
    );
  });
});
