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
  effectiveAmountCents,
  effectiveBps,
  eligibleAt,
  recipientAmountCents,
  validateRecipients,
} from "../../lib/commissions/calculator";

/** Azúcar de test: un beneficiario cargado por porcentaje. */
const pct = (percentBps: number) => ({ mode: "percent" as const, percentBps });
/** Azúcar de test: un beneficiario cargado por monto fijo, en CENTS. */
const fixed = (fixedAmountCents: number) => ({
  mode: "fixed" as const,
  percentBps: 0,
  fixedAmountCents,
});

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
      recipients: [pct(500), pct(500)],
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
      recipients: [pct(500), pct(500), pct(100)],
      capBps: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.combinedBps).toBe(2100);
  });

  it("sin descuento, una orden admite el cap entero en comisiones", () => {
    const r = checkCombinedCap({
      itemSubtotalCents: 100_000,
      discountCents: 0,
      recipients: [pct(2000)],
      capBps: 2000,
    });
    expect(r.ok).toBe(true);
  });

  // ── Monto fijo contra el cap ───────────────────────────────────────────────
  // El cap se mide SIEMPRE en porcentaje: una fila fija se convierte a su %
  // efectivo sobre la base vigente. Si no, un monto fijo sería la vía para
  // saltear el tope.

  it("convierte un monto fijo a su % efectivo sobre la base y lo suma al cap", () => {
    // Base = 100.000 − 10.000 = 90.000¢. $45,00 fijos = 4.500¢ = 500 bps.
    const r = checkCombinedCap({
      itemSubtotalCents: 100_000,
      discountCents: 10_000,
      recipients: [fixed(4_500), pct(500)],
      capBps: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.totalCommissionBps).toBe(1000);
    expect(r.combinedBps).toBe(2000);
  });

  it("un monto fijo que pasa el cap se RECHAZA igual que un porcentaje", () => {
    // Sin descuento la base es el subtotal: 100.000¢. $201 fijos = 2.010 bps,
    // apenas por encima del cap de 2.000.
    const r = checkCombinedCap({
      itemSubtotalCents: 100_000,
      discountCents: 0,
      recipients: [fixed(20_100)],
      capBps: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.totalCommissionBps).toBe(2010);
    expect(r.undeterminedFixed).toBe(false);
  });

  it("el mismo monto fijo pasa o no según la BASE, no según su tamaño", () => {
    // Espejo del anterior con una base mayor: los mismos $201 caen a 1.005 bps.
    const r = checkCombinedCap({
      itemSubtotalCents: 200_000,
      discountCents: 0,
      recipients: [fixed(20_100)],
      capBps: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.totalCommissionBps).toBe(1005);
  });

  it("un monto fijo sobre base CERO no es evaluable: no pasa, y se marca", () => {
    const r = checkCombinedCap({
      itemSubtotalCents: 0,
      discountCents: 0,
      recipients: [fixed(50_000)],
      capBps: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.undeterminedFixed).toBe(true);
  });

  it("base cero NO cuenta un monto fijo como 0 bps (sería saltear el cap entero)", () => {
    const r = checkCombinedCap({
      itemSubtotalCents: 0,
      discountCents: 0,
      recipients: [fixed(9_999_999)],
      capBps: 2000,
    });
    expect(r.totalCommissionBps).toBe(0);
    expect(r.ok).toBe(false);
  });

  // ── Fix C: el cap vivo se mide sólo contra los recipients que van a cobrar ──
  // (writer.ts refreshCommission filtra `state !== 'void'` ANTES de llamar
  // acá — checkCombinedCap no sabe de estados, así que el filtro importa en
  // el CALLER, y estos tests prueban que importa: la misma orden con y sin
  // la fila void da un combinado distinto).

  it("un recipient void NO debe estar en la lista pasada — 3 filas vs 2 dan combinados distintos", () => {
    // 3 recipients (uno de ellos sería 'void' y NO debería llegar acá).
    const withVoidRow = checkCombinedCap({
      itemSubtotalCents: 100_000,
      discountCents: 10_000,
      recipients: [pct(500), pct(500), pct(100)],
      capBps: 2000,
    });
    // La misma orden, filtrando la fila void ANTES de llamar (lo que hace
    // refreshCommission).
    const withoutVoidRow = checkCombinedCap({
      itemSubtotalCents: 100_000,
      discountCents: 10_000,
      recipients: [pct(500), pct(500)],
      capBps: 2000,
    });
    expect(withVoidRow.combinedBps).not.toBe(withoutVoidRow.combinedBps);
    expect(withVoidRow.combinedBps).toBe(2100);
    expect(withoutVoidRow.combinedBps).toBe(2000);
  });

  it("una fila fixed sobre base 0 marca undeterminedFixed:true y ok:false", () => {
    const r = checkCombinedCap({
      itemSubtotalCents: 5_000,
      discountCents: 5_000, // base = max(0, 5000-5000) = 0
      recipients: [fixed(1_000)],
      capBps: 2000,
    });
    expect(r.undeterminedFixed).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("descuento que sube tras asignar empuja combinedBps por encima del cap (5% comisión + 10%→18% descuento, cap 20%)", () => {
    // Al asignar: descuento 10% + comisión 5% = 15% ≤ cap 20% → ok.
    const atAssignment = checkCombinedCap({
      itemSubtotalCents: 100_000,
      discountCents: 10_000,
      recipients: [pct(500)],
      capBps: 2000,
    });
    expect(atAssignment.ok).toBe(true);
    expect(atAssignment.combinedBps).toBe(1500);

    // El descuento sube a 18% sin tocar la comisión: 18% + 5% = 23% > 20%.
    const afterDiscountIncrease = checkCombinedCap({
      itemSubtotalCents: 100_000,
      discountCents: 18_000,
      recipients: [pct(500)],
      capBps: 2000,
    });
    expect(afterDiscountIncrease.ok).toBe(false);
    expect(afterDiscountIncrease.discountBps).toBe(1800);
    expect(afterDiscountIncrease.combinedBps).toBe(2300);
  });
});

describe("effectiveAmountCents / effectiveBps", () => {
  it("una fila por % deriva su monto de la base", () => {
    expect(effectiveAmountCents(90_000, pct(500))).toBe(4_500);
  });

  it("una fila FIJA vale su monto exacto y la base no la toca", () => {
    expect(effectiveAmountCents(90_000, fixed(50_000))).toBe(50_000);
    expect(effectiveAmountCents(10, fixed(50_000))).toBe(50_000);
    expect(effectiveAmountCents(0, fixed(50_000))).toBe(50_000);
  });

  it("el centavo exacto sobrevive: $500 sobre $29.018,23 NO se degrada a $499,11", () => {
    // Es el caso que motivó el modo: 500,00 vale 172,31 bps y guardarlo como
    // 172 bps devolvía 499,11. Guardando el monto, vuelve intacto.
    const base = 2_901_823;
    expect(effectiveAmountCents(base, fixed(50_000))).toBe(50_000);
    expect(effectiveAmountCents(base, pct(172))).toBe(49_911);
  });

  it("el % de una fila fija se DERIVA de la base vigente", () => {
    expect(effectiveBps(2_901_823, fixed(50_000))).toBe(172);
    expect(effectiveBps(90_000, fixed(4_500))).toBe(500);
  });

  it("una fila fija sobre base cero no tiene % determinable", () => {
    expect(effectiveBps(0, fixed(50_000))).toBeNull();
    expect(effectiveBps(0, fixed(0))).toBe(0);
  });

  it("el % de una fila por porcentaje es el guardado, sin derivar", () => {
    expect(effectiveBps(0, pct(500))).toBe(500);
    expect(effectiveBps(90_000, pct(500))).toBe(500);
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
    { customerId: "cus_1", ...pct(500) },
    { qbVendorId: "80000-123", ...pct(300) },
  ];

  it("acepta hasta 3 beneficiarios con porcentaje positivo", () => {
    expect(validateRecipients(ok)).toEqual({ ok: true });
  });

  it("rechaza más de 3", () => {
    const four = [...ok, { customerId: "cus_2", ...pct(100) }, { customerId: "cus_3", ...pct(100) }];
    const r = validateRecipients(four);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_many_recipients");
  });

  it("rechaza porcentaje cero o negativo", () => {
    const r = validateRecipients([{ customerId: "cus_1", ...pct(0) }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_percent");
  });

  it("rechaza beneficiario sin identidad (ni customer ni vendor)", () => {
    const r = validateRecipients([{ ...pct(100) }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_identity");
  });

  it("rechaza beneficiario repetido (mismo customer)", () => {
    const r = validateRecipients([
      { customerId: "cus_1", ...pct(100) },
      { customerId: "cus_1", ...pct(200) },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("duplicate_recipient");
  });

  // ── Modo fijo ──────────────────────────────────────────────────────────────

  it("acepta un beneficiario por monto fijo", () => {
    expect(validateRecipients([{ customerId: "cus_1", ...fixed(50_000) }])).toEqual({ ok: true });
  });

  it("rechaza un monto fijo cero o negativo", () => {
    for (const amount of [0, -1]) {
      const r = validateRecipients([{ customerId: "cus_1", ...fixed(amount) }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid_fixed_amount");
    }
  });

  it("rechaza un monto fijo con centavos fraccionarios", () => {
    const r = validateRecipients([{ customerId: "cus_1", ...fixed(500.5) }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_fixed_amount");
  });

  it("una fila fija NO se valida por su percent_bps: el del otro modo no se mira", () => {
    // percentBps 0 sería inválido en modo 'percent'; en 'fixed' es irrelevante
    // porque no decide plata. Si el validador mirara los dos campos, un
    // percent_bps de arrastre podría rechazar (o peor, gobernar) una fila fija.
    expect(validateRecipients([{ customerId: "cus_1", mode: "fixed", percentBps: 0, fixedAmountCents: 1 }])).toEqual({
      ok: true,
    });
  });

  it("una fila por % sin monto fijo sigue siendo válida (nada exige el campo del otro modo)", () => {
    expect(validateRecipients([{ customerId: "cus_1", ...pct(1) }])).toEqual({ ok: true });
  });

  it("mezcla los dos modos en la misma asignación", () => {
    const r = validateRecipients([
      { customerId: "cus_1", ...pct(500) },
      { qbVendorId: "80000-123", ...fixed(25_000) },
    ]);
    expect(r).toEqual({ ok: true });
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
