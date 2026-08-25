/**
 * Pure math of per-line separation: physical caps and the derived tri-state.
 *
 * Since 2026-08-12 the cross-order arbiter is the SEPARATION, not the
 * reservation (owner decision): reservations can be air (allow_backorder at
 * zero stock) and unseparated stock covers nobody. The cases that matter and
 * cannot be trusted to a green sandbox run:
 *  - live separations of OTHER orders shrink the pool; reservations do not;
 *  - a stored sibling separation (same order, same item) is real demand even
 *    when the request does not mention that line;
 *  - a stored value the stock no longer backs is never forced down — any
 *    request at or below it passes;
 *  - the legacy boolean (is_separated with no rows) still reads as full.
 */

import {
  computeSeparationCaps,
  effectiveSeparatedOf,
  separationStatusLinesOf,
  validateSeparationRequest,
  type InventorySnapshot,
  type SeparationLineInput,
} from "../../api/admin/orders/_lib/separation-caps";
import { deriveSeparationStatus } from "../../api/admin/orders/_lib/separation-status";

const inv = (
  stocked: number,
  reservedAllOrders = 0,
  separatedElsewhere = 0
): InventorySnapshot => ({
  stocked,
  reservedAllOrders,
  separatedElsewhere,
});

const line = (
  overrides: Partial<SeparationLineInput> & { lineId: string }
): SeparationLineInput => ({
  quantity: 0,
  fulfilled: 0,
  invoiced: 0,
  reserved: 0,
  separated: 0,
  inventoryItemId: "iitem_a",
  ...overrides,
});

describe("computeSeparationCaps", () => {
  it("caps at open qty when stock is plentiful", () => {
    const caps = computeSeparationCaps(
      [line({ lineId: "l1", quantity: 7, fulfilled: 2 })],
      new Map([["iitem_a", inv(100)]])
    );
    expect(caps[0]).toMatchObject({ openQty: 5, cap: 5 });
  });

  it("live separations of other orders shrink the pool", () => {
    const caps = computeSeparationCaps(
      [line({ lineId: "l1", quantity: 10 })],
      new Map([["iitem_a", inv(10, 0, 4)]])
    );
    expect(caps[0].cap).toBe(6);
  });

  it("other orders' RESERVATIONS no longer shrink the cap", () => {
    // 4 stocked, 10 reserved across orders, nothing separated elsewhere:
    // under the pre-2026-08-12 model this capped at 0 — now stock unclaimed
    // by a separation is fair game.
    const caps = computeSeparationCaps(
      [line({ lineId: "l1", quantity: 4, reserved: 4 })],
      new Map([["iitem_a", inv(4, 10)]])
    );
    expect(caps[0].cap).toBe(4);
  });

  it("zero stock grants no cap even with a reservation (air)", () => {
    const caps = computeSeparationCaps(
      [line({ lineId: "l1", quantity: 7, reserved: 7 })],
      new Map([["iitem_a", inv(0, 7)]])
    );
    expect(caps[0].cap).toBe(0);
  });

  it("separations elsewhere at or above stock zero the cap", () => {
    const caps = computeSeparationCaps(
      [line({ lineId: "l1", quantity: 5 })],
      new Map([["iitem_a", inv(6, 0, 9)]])
    );
    expect(caps[0].cap).toBe(0);
  });

  it("a sibling line's stored separation is demand on the same pool", () => {
    const caps = computeSeparationCaps(
      [
        line({ lineId: "l1", quantity: 8, separated: 6 }),
        line({ lineId: "l2", quantity: 8 }),
      ],
      new Map([["iitem_a", inv(10)]])
    );
    // l2 sees 10 − 6 = 4; l1's own stored value is not demand against itself.
    expect(caps.find((c) => c.lineId === "l2")?.cap).toBe(4);
    expect(caps.find((c) => c.lineId === "l1")?.cap).toBe(8);
  });

  it("a line with no inventory item cannot separate", () => {
    const caps = computeSeparationCaps(
      [line({ lineId: "l1", quantity: 3, inventoryItemId: null })],
      new Map()
    );
    expect(caps[0].cap).toBe(0);
  });
});

describe("validateSeparationRequest", () => {
  it("accepts a request within the cap", () => {
    const rejections = validateSeparationRequest(
      [line({ lineId: "l1", quantity: 7 })],
      new Map([["iitem_a", inv(10)]]),
      new Map([["l1", 5]])
    );
    expect(rejections).toEqual([]);
  });

  it("rejects beyond open qty", () => {
    const rejections = validateSeparationRequest(
      [line({ lineId: "l1", quantity: 7, fulfilled: 3 })],
      new Map([["iitem_a", inv(100)]]),
      new Map([["l1", 5]])
    );
    expect(rejections).toEqual([
      { lineId: "l1", requested: 5, cap: 4, reason: "exceeds_open_qty" },
    ]);
  });

  it("rejects a raise past what other orders left on the shelf", () => {
    const rejections = validateSeparationRequest(
      [line({ lineId: "l1", quantity: 10 })],
      new Map([["iitem_a", inv(10, 0, 7)]]),
      new Map([["l1", 5]])
    );
    expect(rejections).toEqual([
      {
        lineId: "l1",
        requested: 5,
        cap: 3,
        reason: "exceeds_claimed_elsewhere",
      },
    ]);
  });

  it("never forces lowering: keeping or reducing an over-cap stored value passes", () => {
    const lines = [line({ lineId: "l1", quantity: 10, separated: 6 })];
    const inventory = new Map([["iitem_a", inv(3)]]); // stock moved; cap is 3 now
    expect(
      validateSeparationRequest(lines, inventory, new Map([["l1", 6]]))
    ).toEqual([]);
    expect(
      validateSeparationRequest(lines, inventory, new Map([["l1", 4]]))
    ).toEqual([]);
  });

  it("two lines of the same item compete with each other", () => {
    // 6 pending each; each asks for 4, so each one's ceiling is 6 − the other's
    // 4 = 2. They cannot both spend the same units even inside one request.
    const lines = [
      line({ lineId: "l1", quantity: 6 }),
      line({ lineId: "l2", quantity: 6 }),
    ];
    const rejections = validateSeparationRequest(
      lines,
      new Map([["iitem_a", inv(5)]]),
      new Map([
        ["l1", 4],
        ["l2", 4],
      ])
    );
    expect(rejections.map((r) => r.lineId).sort()).toEqual(["l1", "l2"]);
    expect(
      rejections.every((r) => r.reason === "exceeds_claimed_elsewhere")
    ).toBe(true);
    expect(rejections.every((r) => r.cap === 2)).toBe(true);
  });

  it("an unmentioned sibling's stored separation still counts as demand", () => {
    const lines = [
      line({ lineId: "l1", quantity: 8, separated: 6 }), // not in the request
      line({ lineId: "l2", quantity: 8 }),
    ];
    const rejections = validateSeparationRequest(
      lines,
      new Map([["iitem_a", inv(10)]]),
      new Map([["l2", 5]])
    );
    // l2's ceiling is its own 8 pending minus the 6 its sibling holds.
    expect(rejections).toEqual([
      {
        lineId: "l2",
        requested: 5,
        cap: 2,
        reason: "exceeds_claimed_elsewhere",
      },
    ]);
  });

  // [SUPERSEDED → 2026-08-24] Afirmaba que una línea sin inventory item se podía
  // apartar. La razón que daba era sobre el STOCK ("no hay registro" dejó de ser
  // motivo para rechazar), no sobre los servicios — y esa mitad sigue viva en
  // `separation-caps.unit.spec.ts`. Lo que se decidió después es que apartar es
  // FÍSICO: un servicio no tiene unidades que mover.
  it("una línea sin inventory item se rechaza: no hay nada que apartar", () => {
    const rejections = validateSeparationRequest(
      [line({ lineId: "l1", quantity: 3, inventoryItemId: null })],
      new Map(),
      new Map([["l1", 2]])
    );
    expect(rejections).toEqual([
      { lineId: "l1", requested: 2, cap: 0, reason: "not_separable" },
    ]);
  });

  it("se rechaza incluso pidiendo 0 — mencionarla ya es el error", () => {
    // Un 0 parece inocuo, pero significa que quien llamó cree que la línea
    // participa. La pantalla ya no la dibuja; la ruta lo dice explícito en vez
    // de aceptar en silencio una escritura que no significa nada.
    expect(
      validateSeparationRequest(
        [line({ lineId: "l1", quantity: 3, inventoryItemId: null })],
        new Map(),
        new Map([["l1", 0]])
      )[0]?.reason
    ).toBe("not_separable");
  });

  it("el rechazo nombra 'not_separable', nunca 'falta inventario'", () => {
    // Los tres rechazos viajan por el mismo 409 y piden acciones OPUESTAS:
    // decirle al depósito que busque stock de una instalación lo manda a buscar
    // un problema que no tiene.
    const reasons = validateSeparationRequest(
      [
        line({ lineId: "l1", quantity: 3, inventoryItemId: null }),
        line({ lineId: "l2", quantity: 3 }),
      ],
      new Map([["iitem_a", inv(10)]]),
      new Map([
        ["l1", 1],
        ["l2", 1],
      ])
    ).map((r) => r.reason);
    expect(reasons).toEqual(["not_separable"]);
  });

  it("separationStatusLinesOf saca los servicios del estado de la orden", () => {
    // Sin esto una orden con una instalación no llega a `full` ni apartando
    // todo lo físico: el servicio aporta pendiente que nadie puede apartar.
    const lines = [
      line({ lineId: "l1", quantity: 3, separated: 3 }),
      line({ lineId: "svc", quantity: 2, inventoryItemId: null }),
    ];
    expect(separationStatusLinesOf(lines).map((l) => l.lineId)).toEqual(["l1"]);
    expect(
      deriveSeparationStatus(
        separationStatusLinesOf(lines).map((l) => ({
          quantity: l.quantity,
          fulfilled: l.fulfilled,
          separated: l.separated,
        })),
        false
      )
    ).toBe("full");
  });
});

describe("deriveSeparationStatus", () => {
  it("none when nothing separated and no legacy flag", () => {
    expect(
      deriveSeparationStatus([{ quantity: 5, fulfilled: 0, separated: 0 }], false)
    ).toBe("none");
  });

  it("legacy boolean with no rows reads as full", () => {
    expect(
      deriveSeparationStatus([{ quantity: 5, fulfilled: 0, separated: 0 }], true)
    ).toBe("full");
  });

  it("partial when some open qty is separated", () => {
    expect(
      deriveSeparationStatus(
        [
          { quantity: 5, fulfilled: 0, separated: 5 },
          { quantity: 3, fulfilled: 0, separated: 0 },
        ],
        false
      )
    ).toBe("partial");
  });

  it("full when every open line is covered", () => {
    expect(
      deriveSeparationStatus(
        [
          { quantity: 5, fulfilled: 0, separated: 5 },
          { quantity: 3, fulfilled: 3, separated: 0 }, // fulfilled needs nothing
        ],
        false
      )
    ).toBe("full");
  });

  it("rows win over the legacy flag once they exist", () => {
    expect(
      deriveSeparationStatus([{ quantity: 5, fulfilled: 0, separated: 2 }], true)
    ).toBe("partial");
  });

  it("over-separated rows clamp to open qty (still full, never >100%)", () => {
    expect(
      deriveSeparationStatus([{ quantity: 5, fulfilled: 2, separated: 5 }], false)
    ).toBe("full");
  });
});

/**
 * El piso facturado cuenta como apartado para el ESTADO de la orden, no sólo
 * para el display del modal. Los tres llamadores de `deriveSeparationStatus`
 * pasaban el `separated` crudo: una orden cuyas unidades restantes estaban
 * facturadas sin fila física (3021/S11432: 122 con fila + 40 sólo facturadas
 * sobre 162 abiertas) estampaba `partial` mientras el modal mostraba todo
 * apartado y la lista decía full por el atajo `fully_invoiced`.
 */
describe("effectiveSeparatedOf", () => {
  it("a line covered only by invoices counts its floor as separated", () => {
    expect(
      effectiveSeparatedOf(
        line({ lineId: "l1", quantity: 7, fulfilled: 0, invoiced: 7 })
      )
    ).toBe(7);
  });

  it("the floor nets out what already left the warehouse", () => {
    expect(
      effectiveSeparatedOf(
        line({ lineId: "l1", quantity: 31, fulfilled: 24, invoiced: 31 })
      )
    ).toBe(7);
  });

  it("the stored separation wins when it is higher than the floor", () => {
    expect(
      effectiveSeparatedOf(
        line({ lineId: "l1", quantity: 10, fulfilled: 0, invoiced: 2, separated: 5 })
      )
    ).toBe(5);
  });

  it("the 3021 shape derives full: physical rows + invoiced-only lines", () => {
    const lines = [
      // EMSH: 264 ordenadas, 142 entregadas, 122 con fila física.
      line({ lineId: "emsh", quantity: 264, fulfilled: 142, invoiced: 264, separated: 122 }),
      // ECTSK: 31 ordenadas, 12 entregadas, sin fila — cubierta por el piso.
      line({ lineId: "ectsk", quantity: 31, fulfilled: 12, invoiced: 31 }),
      // ECTL: nada entregado, todo facturado, sin fila.
      line({ lineId: "ectl", quantity: 7, fulfilled: 0, invoiced: 7 }),
    ];
    expect(
      deriveSeparationStatus(
        lines.map((l) => ({
          quantity: l.quantity,
          fulfilled: l.fulfilled,
          separated: effectiveSeparatedOf(l),
        })),
        false
      )
    ).toBe("full");
  });

  it("a floor that covers only part of the open qty derives partial", () => {
    const lines = [
      line({ lineId: "l1", quantity: 10, fulfilled: 0, invoiced: 4 }),
    ];
    expect(
      deriveSeparationStatus(
        lines.map((l) => ({
          quantity: l.quantity,
          fulfilled: l.fulfilled,
          separated: effectiveSeparatedOf(l),
        })),
        false
      )
    ).toBe("partial");
  });

  it("legacy flag survives when there is neither a row nor a floor", () => {
    const lines = [line({ lineId: "l1", quantity: 5, fulfilled: 0 })];
    expect(
      deriveSeparationStatus(
        lines.map((l) => ({
          quantity: l.quantity,
          fulfilled: l.fulfilled,
          separated: effectiveSeparatedOf(l),
        })),
        true
      )
    ).toBe("full");
  });

  it("a floor overrides the legacy flag: the numbers win once they exist", () => {
    // Decisión deliberada: una orden legacy (is_separated sin filas) con
    // invoices PARCIALES pasa a `partial` — el piso es evidencia por línea,
    // más fresca que un booleano pre-tracking. Las 4 órdenes legacy vivas de
    // prod se enumeran en el dry-run del backfill antes de estampar nada.
    const lines = [line({ lineId: "l1", quantity: 10, fulfilled: 0, invoiced: 4 })];
    expect(
      deriveSeparationStatus(
        lines.map((l) => ({
          quantity: l.quantity,
          fulfilled: l.fulfilled,
          separated: effectiveSeparatedOf(l),
        })),
        true
      )
    ).toBe("partial");
  });
});
