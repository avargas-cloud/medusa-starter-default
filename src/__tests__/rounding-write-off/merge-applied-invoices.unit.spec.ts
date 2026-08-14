/**
 * `mergeAppliedInvoices` — la regla que decide si un write-off de redondeo ya
 * asentado en QuickBooks sobrevive al próximo `ReceivePaymentMod`.
 *
 * El caso que importa es el TERCERO: el pago se aplica a una factura NUEVA, y la
 * factura vieja —que ya tenía su centavo saldado— tiene que salir del merge con
 * su descuento intacto. Si no, `AppliedToTxnMod` (REPLACE-ALL) se lo borra y esa
 * factura vuelve a mostrar saldo abierto sin que ninguna operación falle.
 * Es la misma forma del clobber de agosto 2026, con otro campo.
 */

import {
  mergeAppliedInvoices,
  type AppliedInvoiceState,
} from "../../lib/quickbooks/client/payments";

const SHORTAGE_ACCOUNT = "80000101-1454537545";

describe("mergeAppliedInvoices", () => {
  it("agrega una aplicación nueva a una lista vacía", () => {
    expect(mergeAppliedInvoices([], { invoiceId: "I1", amount: 210.92 })).toEqual(
      [{ invoiceId: "I1", amount: 210.92 }]
    );
  });

  it("actualiza el monto de una aplicación existente sin duplicarla", () => {
    const out = mergeAppliedInvoices([{ invoiceId: "I1", amount: 100 }], {
      invoiceId: "I1",
      amount: 250,
    });
    expect(out).toEqual([{ invoiceId: "I1", amount: 250 }]);
  });

  it("PRESERVA el descuento de una factura AJENA al aplicar el pago a otra", () => {
    const current: AppliedInvoiceState[] = [
      {
        invoiceId: "I-vieja",
        amount: 674.95,
        discountAmount: 0.01,
        discountAccountListId: SHORTAGE_ACCOUNT,
      },
    ];

    const out = mergeAppliedInvoices(current, {
      invoiceId: "I-nueva",
      amount: 210.92,
    });

    const vieja = out.find((a) => a.invoiceId === "I-vieja");
    expect(vieja).toEqual(current[0]);
    expect(vieja?.discountAmount).toBe(0.01);
    expect(vieja?.discountAccountListId).toBe(SHORTAGE_ACCOUNT);
  });

  it("un apply posterior a la MISMA factura sin descuento NO borra el que ya tenía", () => {
    // "undefined" significa "no lo toques". Revertir un ajuste es explícito.
    const out = mergeAppliedInvoices(
      [
        {
          invoiceId: "I1",
          amount: 674.95,
          discountAmount: 0.01,
          discountAccountListId: SHORTAGE_ACCOUNT,
        },
      ],
      { invoiceId: "I1", amount: 674.95 }
    );
    expect(out[0]?.discountAmount).toBe(0.01);
    expect(out[0]?.discountAccountListId).toBe(SHORTAGE_ACCOUNT);
  });

  it("un descuento nuevo pisa al anterior de la MISMA factura", () => {
    const out = mergeAppliedInvoices(
      [
        {
          invoiceId: "I1",
          amount: 100,
          discountAmount: 0.01,
          discountAccountListId: SHORTAGE_ACCOUNT,
        },
      ],
      {
        invoiceId: "I1",
        amount: 100,
        discountAmount: 0.02,
        discountAccountListId: "80000100-1454537520",
      }
    );
    expect(out[0]?.discountAmount).toBe(0.02);
    expect(out[0]?.discountAccountListId).toBe("80000100-1454537520");
  });

  it("monto sin cuenta NO produce un descuento a medias (par atómico)", () => {
    const out = mergeAppliedInvoices([], {
      invoiceId: "I1",
      amount: 100,
      discountAmount: 0.01,
    });
    expect(out[0]?.discountAmount).toBeUndefined();
    expect(out[0]?.discountAccountListId).toBeUndefined();
  });

  it("cuenta sin monto tampoco", () => {
    const out = mergeAppliedInvoices([], {
      invoiceId: "I1",
      amount: 100,
      discountAccountListId: SHORTAGE_ACCOUNT,
    });
    expect(out[0]?.discountAmount).toBeUndefined();
  });

  it("no muta la lista de entrada", () => {
    const current: AppliedInvoiceState[] = [{ invoiceId: "I1", amount: 100 }];
    const snapshot = JSON.parse(JSON.stringify(current));
    mergeAppliedInvoices(current, { invoiceId: "I1", amount: 999 });
    expect(current).toEqual(snapshot);
  });

  it("escenario completo S11417/S11438: dos facturas, la primera con write-off", () => {
    const current: AppliedInvoiceState[] = [
      { invoiceId: "QB-21402", amount: 210.92 },
      {
        invoiceId: "QB-21422",
        amount: 674.95,
        discountAmount: 0.01,
        discountAccountListId: SHORTAGE_ACCOUNT,
      },
    ];
    // Llega un tercer apply cualquiera sobre la primera factura.
    const out = mergeAppliedInvoices(current, {
      invoiceId: "QB-21402",
      amount: 210.92,
    });

    expect(out).toHaveLength(2);
    const conWriteOff = out.filter((a) => a.discountAmount !== undefined);
    expect(conWriteOff).toHaveLength(1);
    expect(conWriteOff[0]?.invoiceId).toBe("QB-21422");
  });
});
