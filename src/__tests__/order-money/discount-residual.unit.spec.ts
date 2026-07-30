/**
 * discount-residual.unit.spec.ts
 *
 * Clava la separación entre un DESCUENTO y un DESACUERDO DE CONVENCIÓN.
 *
 * Por qué existe: `resolvePatchedOrderTotal` y `resolveQbParityTax` no tenían
 * NINGÚN unit spec, y su resta del residual es el punto exacto donde se
 * encuentran las dos formas de expresar el mismo descuento —la per-línea (POS,
 * documento del cliente, QuickBooks) y la agregada (Medusa)—. Un centavo de
 * diferencia entre ellas era aritméticamente idéntico a un centavo de descuento
 * nuevo, así que se restaba en silencio.
 *
 * Los números NO son inventados: salen de la orden 2811 / S11242, cuya QB
 * Invoice 19614 fue leída del bridge y congelada en
 * `docs/qb-ground-truth-2026-07-30.json`. QuickBooks facturó TOTAL 1699.07 con
 * un descuento de 138.07; el agregado del mismo descuento da 138.08 y el crudo
 * de Medusa 138.0792.
 */

import {
  resolveDiscountResidual,
  resolvePatchedOrderTotal,
  resolveQbParityTax,
  type OrderMoneyBase,
} from "../../lib/order-money/order-tax-lines";

/** La base real de la orden 2811, tal como la devuelve `loadOrderMoneyBase`. */
const ORDER_2811: OrderMoneyBase = {
  netDollars: 1587.92,
  taxableNetDollars: 1587.92,
  shippingDollars: 0,
  adjustmentsDollars: 138.07, // per-línea: Σ round(descuento de cada línea)
  bakedDiscountDollars: 0,
  discountedLineCount: 11,
};

const QB_TOTAL_19614 = 1699.07;
const QB_TAX = 111.15;

describe("resolveDiscountResidual", () => {
  it("aplica entero un descuento que la base todavía no carga", () => {
    // El caso E2606: anunciado por el caller, sin materializar en ninguna línea.
    const base: OrderMoneyBase = {
      ...ORDER_2811,
      adjustmentsDollars: 0,
      discountedLineCount: 0,
    };
    expect(resolveDiscountResidual(base, 15.99)).toEqual({
      residualCents: 1599,
      conventionGapCents: 0,
    });
  });

  it("no resta nada cuando el caller trae el MISMO descuento en per-línea", () => {
    expect(resolveDiscountResidual(ORDER_2811, 138.07)).toEqual({
      residualCents: 0,
      conventionGapCents: 0,
    });
  });

  it.each([
    ["el agregado redondeado", 138.08, 1],
    ["el crudo de Medusa", 138.0792, 1],
  ])(
    "denuncia %s como desacuerdo de convención y NO lo resta",
    (_label, discount, gap) => {
      expect(resolveDiscountResidual(ORDER_2811, discount as number)).toEqual({
        residualCents: 0,
        conventionGapCents: gap,
      });
    }
  );

  it("resta de verdad lo que excede el slack de redondeo", () => {
    // 11 líneas descontadas ⇒ slack 6¢. 10¢ por encima de la base no puede ser
    // redondeo, así que es descuento y se resta.
    expect(resolveDiscountResidual(ORDER_2811, 138.17)).toEqual({
      residualCents: 10,
      conventionGapCents: 0,
    });
  });

  it("el slack escala con las líneas descontadas, no es una constante", () => {
    const unaLinea: OrderMoneyBase = { ...ORDER_2811, discountedLineCount: 1 };
    // Con UNA línea el slack es 1¢: 2¢ de diferencia ya son descuento.
    expect(resolveDiscountResidual(unaLinea, 138.09).residualCents).toBe(2);
    // Con 11 líneas, esos mismos 2¢ entran en el slack.
    expect(resolveDiscountResidual(ORDER_2811, 138.09).residualCents).toBe(0);
  });
});

describe("el total de la orden 2811 contra lo que QuickBooks facturó", () => {
  it.each([
    ["sin descuento anunciado", 0],
    ["descuento per-línea 138.07", 138.07],
    ["descuento agregado 138.08", 138.08],
    ["descuento crudo 138.0792", 138.0792],
  ])(
    "converge en 1699.07 con %s",
    (_label, discount) => {
      const parity = resolveQbParityTax(ORDER_2811, discount as number, 7);
      expect(parity.taxableBase).toBe(1587.92);
      expect(parity.tax).toBe(QB_TAX);

      const resolved = resolvePatchedOrderTotal({
        base: ORDER_2811,
        posTaxAmount: parity.tax,
        discount: discount as number,
      });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.total).toBe(QB_TOTAL_19614);
    }
  );

  it("el desacuerdo de convención sale en las warnings, no en silencio", () => {
    const resolved = resolvePatchedOrderTotal({
      base: ORDER_2811,
      posTaxAmount: QB_TAX,
      discount: 138.08,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(
        resolved.warnings.some((w) => w.includes("CONVENTION GAP"))
      ).toBe(true);
    }
  });
});
