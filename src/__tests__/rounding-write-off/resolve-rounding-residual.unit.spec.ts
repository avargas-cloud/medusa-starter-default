/**
 * Las cuatro ramas de `resolveRoundingResidual`, más las de entrada inválida.
 *
 * La rama que importa de verdad es la de RECHAZO: es la única protección del
 * mecanismo (no hay PIN ni override), así que si se rompiera, un desvío grande
 * se absorbería en silencio contra una cuenta de ingresos — que es exactamente
 * el riesgo de auditoría que este diseño existe para evitar.
 */

import {
  ROUNDING_WRITE_OFF_CAP_CENTS,
  buildRoundingMemo,
  resolveRoundingResidual,
} from "../../lib/rounding/write-off";

describe("resolveRoundingResidual", () => {
  it("sin residuo no emite nada (el 99% de las facturas)", () => {
    expect(resolveRoundingResidual(0)).toEqual({ kind: "none" });
  });

  it("residuo positivo dentro del tope → shortage contra la cuenta de shortages", () => {
    // Caso real: factura 21422, total 674.96, aplicado 674.95.
    expect(resolveRoundingResidual(1)).toEqual({
      kind: "writeoff",
      direction: "shortage",
      amountCents: 1,
      accountKey: "shortage",
    });
  });

  it("residuo negativo dentro del tope → overage contra la cuenta de overages", () => {
    // El espejo: las fracciones del tax redondearon ABAJO y sobró plata aplicada.
    expect(resolveRoundingResidual(-1)).toEqual({
      kind: "writeoff",
      direction: "overage",
      amountCents: 1,
      accountKey: "overage",
    });
  });

  it("el monto emitido es SIEMPRE positivo — la dirección carga el signo", () => {
    const r = resolveRoundingResidual(-4);
    expect(r.kind).toBe("writeoff");
    if (r.kind !== "writeoff") throw new Error("unreachable");
    expect(r.amountCents).toBeGreaterThan(0);
  });

  it("acepta exactamente el tope, en las dos direcciones", () => {
    expect(resolveRoundingResidual(ROUNDING_WRITE_OFF_CAP_CENTS).kind).toBe(
      "writeoff"
    );
    expect(resolveRoundingResidual(-ROUNDING_WRITE_OFF_CAP_CENTS).kind).toBe(
      "writeoff"
    );
  });

  it("RECHAZA un centavo por encima del tope, en las dos direcciones", () => {
    for (const v of [
      ROUNDING_WRITE_OFF_CAP_CENTS + 1,
      -(ROUNDING_WRITE_OFF_CAP_CENTS + 1),
    ]) {
      const r = resolveRoundingResidual(v);
      expect(r.kind).toBe("refused");
      if (r.kind !== "refused") throw new Error("unreachable");
      expect(r.reason).toMatch(/supera el tope/);
    }
  });

  it("RECHAZA un desvío grande — no lo absorbe ni parcialmente", () => {
    const r = resolveRoundingResidual(67495);
    expect(r.kind).toBe("refused");
  });

  it("RECHAZA centavos fraccionarios en vez de redondearlos", () => {
    // Un fraccionario acá significa dólares mal pasados o un BigNumber sin
    // coercionar. Redondear en silencio convierte un bug de unidades en un
    // asiento contable.
    const r = resolveRoundingResidual(0.7);
    expect(r.kind).toBe("refused");
    if (r.kind !== "refused") throw new Error("unreachable");
    expect(r.reason).toMatch(/entero de centavos/);
  });

  it("RECHAZA NaN e Infinity", () => {
    expect(resolveRoundingResidual(Number.NaN).kind).toBe("refused");
    expect(resolveRoundingResidual(Number.POSITIVE_INFINITY).kind).toBe(
      "refused"
    );
  });
});

describe("buildRoundingMemo", () => {
  it("nombra la factura — es lo único que distingue el asiento de un descuadre de caja", () => {
    expect(buildRoundingMemo(21422)).toBe("Rounding - INV 21422");
  });

  it("es ASCII puro — el escapeXml del bridge translitera, y el memo local debe coincidir con el de QuickBooks", () => {
    const memo = buildRoundingMemo(21422);
    expect([...memo].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    expect(Buffer.byteLength(memo)).toBe(memo.length);
  });
});
