/**
 * Las tres condiciones del disparador de overage.
 *
 * Cada una existe por un motivo distinto y las tres son necesarias. Los dos
 * casos que más importan son de RECHAZO, porque absorber de más regala plata
 * del cliente a la cuenta de resultados:
 *
 *   - orden a medio facturar  → el remanente es de la factura que viene
 *   - factura todavía abierta → el remanente tiene destino
 */

import { ROUNDING_WRITE_OFF_CAP_CENTS } from "../../lib/rounding/write-off";
import { decideOverage, type OverageFacts } from "../../lib/rounding/overage";

/** Orden cerrada de 885.86 facturados, todo saldado, con 1¢ sobrando. */
const CERRADA: OverageFacts = {
  orderId: "order_x",
  remainderCents: 1,
  orderTotalCents: 88586,
  invoicedCents: 88586,
  openBalanceCents: 0,
};

describe("decideOverage", () => {
  it("absorbe 1¢ cuando la orden cerró y todo está saldado", () => {
    expect(decideOverage(CERRADA)).toEqual({ kind: "absorb", amountCents: 1 });
  });

  it("acepta exactamente el tope", () => {
    expect(
      decideOverage({ ...CERRADA, remainderCents: ROUNDING_WRITE_OFF_CAP_CENTS })
        .kind
    ).toBe("absorb");
  });

  it("RECHAZA un centavo por encima del tope", () => {
    const d = decideOverage({
      ...CERRADA,
      remainderCents: ROUNDING_WRITE_OFF_CAP_CENTS + 1,
    });
    expect(d.kind).toBe("skip");
    if (d.kind !== "skip") throw new Error("unreachable");
    expect(d.reason).toMatch(/tope/);
  });

  it("no hace nada cuando no sobra plata", () => {
    expect(decideOverage({ ...CERRADA, remainderCents: 0 }).kind).toBe("skip");
    expect(decideOverage({ ...CERRADA, remainderCents: -5 }).kind).toBe("skip");
  });

  it("RECHAZA si la orden todavía no terminó de facturarse", () => {
    // Éste es el que evita quedarse con el anticipo de una factura futura.
    const d = decideOverage({ ...CERRADA, invoicedCents: 40000 });
    expect(d.kind).toBe("skip");
    if (d.kind !== "skip") throw new Error("unreachable");
    expect(d.reason).toMatch(/totalmente facturada/);
  });

  it("RECHAZA si alguna factura de la orden sigue debiendo", () => {
    // Acá el remanente SÍ tiene destino: aplicarlo, no absorberlo.
    const d = decideOverage({ ...CERRADA, openBalanceCents: 2500 });
    expect(d.kind).toBe("skip");
    if (d.kind !== "skip") throw new Error("unreachable");
    expect(d.reason).toMatch(/saldo abierto/);
  });

  it("RECHAZA un pago sin atribución de orden (podría ser un depósito general)", () => {
    const d = decideOverage({ ...CERRADA, orderId: null });
    expect(d.kind).toBe("skip");
    if (d.kind !== "skip") throw new Error("unreachable");
    expect(d.reason).toMatch(/atribuido/);
  });

  it("RECHAZA si el total de la orden es ilegible — fail-closed", () => {
    expect(decideOverage({ ...CERRADA, orderTotalCents: null }).kind).toBe("skip");
  });

  it("RECHAZA centavos fraccionarios en vez de redondearlos", () => {
    const d = decideOverage({ ...CERRADA, remainderCents: 0.5 });
    expect(d.kind).toBe("skip");
    if (d.kind !== "skip") throw new Error("unreachable");
    expect(d.reason).toMatch(/entero de centavos/);
  });

  it("sobre-facturado (invoiced > total) sigue siendo elegible", () => {
    // Es exactamente el caso de la orden partida: Σ facturas supera al total de
    // la orden por el redondeo del tax. La condición es "ya no falta facturar",
    // no "coincide exacto".
    expect(
      decideOverage({ ...CERRADA, invoicedCents: 88587 }).kind
    ).toBe("absorb");
  });

  it("escenario espejo completo: 885.87 cobrado, 885.86 facturado", () => {
    const d = decideOverage({
      orderId: "order_espejo",
      remainderCents: 1, // 88587 − 88586
      orderTotalCents: 88586,
      invoicedCents: 88586,
      openBalanceCents: 0,
    });
    expect(d).toEqual({ kind: "absorb", amountCents: 1 });
  });
});
