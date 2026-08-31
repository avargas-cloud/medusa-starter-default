/**
 * The invoiced floor of a separation (2026-08-20).
 *
 * Invoicing stopped covering a line: a paid invoice whose goods are still on
 * the shelf waiting for pickup is exactly the situation separation exists for.
 * What invoicing does instead is set a MINIMUM — those units are billed to a
 * customer and may not be un-separated.
 *
 * `fulfilled` here means units under a LIVE fulfillment, never
 * `order_item.fulfilled_quantity`; that distinction lives in separation-data.ts
 * and is guarded statically by verify-separation-invoiced.ts §3.
 */

import {
  computeSeparationCaps,
  invoicedFloorOf,
  openQtyOf,
  validateSeparationRequest,
  type InventorySnapshot,
  type SeparationLineInput,
} from "../../api/admin/orders/_lib/separation-caps";

const ITEM = "iitem_1";

function line(over: Partial<SeparationLineInput> = {}): SeparationLineInput {
  return {
    lineId: "l1",
    quantity: 25,
    fulfilled: 0,
    invoiced: 0,
    reserved: 0,
    inventoryItemId: ITEM,
    separated: 0,
    ...over,
  };
}

function stock(stocked: number, elsewhere = 0): Map<string, InventorySnapshot> {
  return new Map([
    [
      ITEM,
      { stocked, reservedAllOrders: 0, separatedElsewhere: elsewhere },
    ],
  ]);
}

describe("pending quantity", () => {
  it("does NOT subtract invoiced units — the S11432 case", () => {
    // 25 ordered, 18 on a paid invoice, nothing fulfilled: every unit is still
    // in the building, so all 25 are pending warehouse work. Under the old
    // rule (covered = max(fulfilled, invoiced)) this line read 7; with the
    // fulfilled_quantity drift on top of it, it read 0.
    expect(openQtyOf(line({ quantity: 25, invoiced: 18, fulfilled: 0 }))).toBe(
      25
    );
  });

  it("subtracts fulfilled units — those left the building", () => {
    expect(openQtyOf(line({ quantity: 25, invoiced: 18, fulfilled: 18 }))).toBe(
      7
    );
  });
});

describe("invoicedFloorOf", () => {
  it("is the invoiced units still in the warehouse", () => {
    expect(invoicedFloorOf(line({ quantity: 25, invoiced: 18 }))).toBe(18);
  });

  it("drops as those units are fulfilled", () => {
    expect(invoicedFloorOf(line({ quantity: 25, invoiced: 18, fulfilled: 12 })))
      .toBe(6);
  });

  it("is zero once everything invoiced has shipped", () => {
    expect(invoicedFloorOf(line({ quantity: 25, invoiced: 18, fulfilled: 18 })))
      .toBe(0);
  });

  it("never exceeds the ordered quantity even if over-invoiced", () => {
    expect(invoicedFloorOf(line({ quantity: 6, invoiced: 9 }))).toBe(6);
  });

  it("is zero when nothing is invoiced", () => {
    expect(invoicedFloorOf(line({ quantity: 25, invoiced: 0 }))).toBe(0);
  });
});

describe("computeSeparationCaps", () => {
  it("reports the floor and the ceiling beside the stock figure", () => {
    const [cap] = computeSeparationCaps(
      [line({ quantity: 25, invoiced: 18 })],
      stock(40)
    );
    expect(cap).toMatchObject({
      openQty: 25,
      cap: 25,
      invoicedFloor: 18,
      maxSeparable: 25,
    });
  });

  it("keeps three separate numbers when they disagree — S11432", () => {
    // 18 units invoiced, ONE in Miami. `cap` is honest about the stock (and
    // paints the row amber), `invoicedFloor` is honest about the promise, and
    // `maxSeparable` lets the operator record what is actually on the shelf.
    // Collapsing any two of them hides a problem the warehouse has to see.
    const [cap] = computeSeparationCaps(
      [line({ quantity: 25, invoiced: 18 })],
      stock(1)
    );
    expect(cap).toMatchObject({
      cap: 1,
      invoicedFloor: 18,
      maxSeparable: 25,
    });
  });

  // [SUPERSEDED → 2026-08-31] Este caso afirmaba `maxSeparable = 5` con 40 en
  // Miami y 20 apartadas por otras órdenes, o sea `openQty − elsewhere`: restaba
  // un reclamo sobre el POOL de la demanda de UNA línea. Era la fórmula del bug,
  // fijada por un test, y por eso pasaba en verde mientras producción devolvía
  // 409. La mitad que sobrevive —el reclamo ajeno sigue atando— se afirma abajo
  // con un estante que de verdad queda corto.
  it("el reclamo ajeno NO descuenta mientras el estante alcance", () => {
    const [cap] = computeSeparationCaps(
      [line({ quantity: 25, invoiced: 0 })],
      stock(40, 20)
    );
    // 20 comprometidas de 40: no hay nada que arbitrar contra estas 25.
    expect(cap.maxSeparable).toBe(25);
    // El estante igual queda corto para las 25, y eso lo dice `cap` en ámbar.
    expect(cap.cap).toBe(20);
  });

  it("el techo baja SÓLO por el sobregiro del estante", () => {
    // 40 en Miami contra 48 apartadas por otras órdenes: 8 de sobregiro real.
    const [cap] = computeSeparationCaps(
      [line({ quantity: 25, invoiced: 0 })],
      stock(40, 48)
    );
    expect(cap.maxSeparable).toBe(17);
    expect(cap.cap).toBe(0);
  });

  it("the ceiling never falls under the floor, whoever else claims units", () => {
    // 10 en Miami contra 30 apartadas afuera: 20 de sobregiro, que dejarían el
    // techo en 5 — pero 18 están facturadas y esperando acá.
    const [cap] = computeSeparationCaps(
      [line({ quantity: 25, invoiced: 18 })],
      stock(10, 30)
    );
    expect(cap.maxSeparable).toBe(18);
  });

  // [SUPERSEDED → 2026-08-24] Este caso afirmaba que una línea SIN inventory
  // item conservaba piso y techo reales (`invoicedFloor: 18, maxSeparable: 25`).
  // La regla que lo justificaba —desde el 2026-08-20 el stock no es el árbitro,
  // así que "no hay registro de stock" dejó de ser motivo para rechazar— sigue
  // VIVA y la cubre el caso de abajo. Lo que cambió es otra cosa: una línea sin
  // inventory item es un SERVICIO (instalación, expedite, un cargo) y apartar es
  // físico. No tiene unidades que mover, así que sale del dominio entero.
  //
  // La trampa que este caso evitaba —un servicio facturado clavado bajo un piso
  // inalcanzable— desaparece porque el piso también se va a 0: la línea queda
  // AFUERA, no clampeada en cero adentro.
  it("una línea sin inventory item queda fuera del dominio: todo en cero", () => {
    const [cap] = computeSeparationCaps(
      [line({ inventoryItemId: null, quantity: 25, invoiced: 18 })],
      stock(40)
    );
    expect(cap).toMatchObject({ cap: 0, invoicedFloor: 0, maxSeparable: 0 });
    // `openQty` sigue siendo VERAZ: el modal de Product Status lo lee para
    // decir cuánto falta que llegue, y ahí un servicio pendiente es un hecho.
    expect(cap.openQty).toBe(25);
  });

  // La mitad que sobrevive de la regla del 2026-08-20, ahora afirmada sola: el
  // stock no es el árbitro. Una línea FÍSICA cuyo inventario dice 0 se sigue
  // pudiendo apartar — el operador mira el estante y el conteo puede estar mal.
  // Es también la assertion que protege contra el modo de falla de este cambio:
  // si el predicado se corriera de "sin inventory item" a "sin stock", este caso
  // se pone rojo antes de que un ítem físico desaparezca de la pantalla.
  it("una línea FÍSICA sin stock sigue siendo separable", () => {
    const [cap] = computeSeparationCaps(
      [line({ quantity: 25, invoiced: 18 })],
      stock(0)
    );
    expect(cap.cap).toBe(0); // el stock no la respalda: es la advertencia ámbar
    expect(cap.maxSeparable).toBe(25); // pero el techo NO es el stock
    expect(cap.invoicedFloor).toBe(18);
  });
});

describe("validateSeparationRequest — the floor", () => {
  const inv = stock(40);

  it("rejects dropping below the invoiced floor", () => {
    const lines = [line({ quantity: 25, invoiced: 18, separated: 18 })];
    const out = validateSeparationRequest(
      lines,
      inv,
      new Map([["l1", 5]])
    );
    expect(out).toEqual([
      { lineId: "l1", requested: 5, cap: 18, reason: "below_invoiced_floor" },
    ]);
  });

  it("rejects clearing a line that holds invoiced units", () => {
    const lines = [line({ quantity: 25, invoiced: 18, separated: 18 })];
    expect(
      validateSeparationRequest(lines, inv, new Map([["l1", 0]]))[0]?.reason
    ).toBe("below_invoiced_floor");
  });

  it("accepts landing exactly on the floor", () => {
    const lines = [line({ quantity: 25, invoiced: 18, separated: 25 })];
    expect(validateSeparationRequest(lines, inv, new Map([["l1", 18]]))).toEqual(
      []
    );
  });

  it("still allows clearing a line with nothing invoiced", () => {
    const lines = [line({ quantity: 25, invoiced: 0, separated: 25 })];
    expect(validateSeparationRequest(lines, inv, new Map([["l1", 0]]))).toEqual(
      []
    );
  });

  it("allows clearing once the invoiced units have been fulfilled", () => {
    const lines = [
      line({ quantity: 25, invoiced: 18, fulfilled: 18, separated: 7 }),
    ];
    expect(validateSeparationRequest(lines, inv, new Map([["l1", 0]]))).toEqual(
      []
    );
  });

  it("no longer gates raises on physical stock", () => {
    const lines = [line({ quantity: 25, invoiced: 0, separated: 0 })];
    expect(
      validateSeparationRequest(lines, stock(4), new Map([["l1", 20]]))
    ).toEqual([]);
  });

  it("lets a line reach its floor even when stock cannot back it", () => {
    // S11432: 18 units invoiced, ONE in Miami. Gating this on stock refuses the
    // row at 0 for being under the floor AND at 18 for being over the stock —
    // the line becomes unsaveable, which is how the two rules cancel out if the
    // floor does not clear the ceiling check.
    const lines = [line({ quantity: 25, invoiced: 18, separated: 0 })];
    expect(
      validateSeparationRequest(lines, stock(1), new Map([["l1", 18]]))
    ).toEqual([]);
  });

  it("lets the operator record MORE than stock says is there", () => {
    // Owner decision 2026-08-20: stocked_quantity is the system's belief and
    // the operator is looking at the shelf. Above the floor, up to the pending
    // quantity, the count does not refuse anything.
    const lines = [line({ quantity: 25, invoiced: 18, separated: 0 })];
    expect(
      validateSeparationRequest(lines, stock(1), new Map([["l1", 25]]))
    ).toEqual([]);
  });

  it("still refuses to go past the ORDERED quantity", () => {
    const lines = [line({ quantity: 25, invoiced: 18, separated: 0 })];
    expect(
      validateSeparationRequest(lines, stock(40), new Map([["l1", 26]]))[0]
        ?.reason
    ).toBe("exceeds_open_qty");
  });

  it("still refuses units another order already keeps separated", () => {
    // [SUPERSEDED → 2026-08-31 en sus NÚMEROS, no en su regla] Este caso usaba
    // `stock(40, 20)` y esperaba un rechazo con techo 5 — pero con 40 en el
    // estante y 20 comprometidas no hay conflicto que arbitrar, y afirmarlo así
    // era fijar el bug. El árbitro cross-orden del 2026-08-12 sigue vivo donde
    // significa algo: 10 en Miami contra 30 apartadas afuera son 20 de
    // sobregiro, así que de las 25 pendientes esta línea puede reclamar 5.
    const lines = [line({ quantity: 25, invoiced: 0, separated: 0 })];
    const out = validateSeparationRequest(
      lines,
      stock(10, 30),
      new Map([["l1", 9]])
    );
    expect(out[0]).toMatchObject({
      cap: 5,
      reason: "exceeds_claimed_elsewhere",
    });
  });

  it("acepta lo que el estante respalda aunque otras órdenes tengan más unidades que las que pide esta línea — S11543", () => {
    // El caso exacto de producción: EMSH4V160D15W30, 88 en Miami, 28 apartadas
    // por otras órdenes, esta orden pide 2. La fórmula vieja daba 2 − 28 = 0 y
    // contestaba 409 "no alcanza el inventario" con 60 unidades libres en el
    // estante. Basta con que otra orden tenga apartadas tantas unidades como
    // las que vos necesitás para que el techo caiga a cero — o sea, para casi
    // cualquier SKU que se mueva.
    const lines = [line({ quantity: 2, invoiced: 0, separated: 0 })];
    expect(
      validateSeparationRequest(lines, stock(88, 28), new Map([["l1", 2]]))
    ).toEqual([]);
  });

  it("gates the floor BEFORE the ceiling, so an unbacked floor is not reported as a stock problem", () => {
    // Only 1 unit in Miami and 18 invoiced. Asking for 0 is refused for being
    // under the floor — telling the operator to go find stock would send them
    // after the wrong problem.
    const lines = [line({ quantity: 25, invoiced: 18, separated: 18 })];
    const out = validateSeparationRequest(
      lines,
      stock(1),
      new Map([["l1", 0]])
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toBe("below_invoiced_floor");
  });
});

/**
 * `cap ≤ maxSeparable`, siempre.
 *
 * No es una curiosidad aritmética: es el contrato entre las dos pantallas y la
 * ruta. `separable_cap` es lo que el modal OFRECE (la columna Separable en
 * ámbar) y lo que el botón "Separate all available" escribe de una
 * (SeparationModal.tsx:148 → `min(open_qty, separable_cap)`); `max_separable`
 * es contra lo que el POST AUTORIZA. Si el primero puede superar al segundo, el
 * botón escribe un número que el Save rechaza — que es exactamente lo que pasó
 * en producción con S11543 el 2026-08-31.
 *
 * Ningún test afirmaba esto. Había casos para `cap`, casos para `maxSeparable`
 * y casos para el piso, todos verdes, y ninguno los comparaba entre sí: el
 * defecto vivía justo en la relación que nadie miraba. Por eso va como
 * PROPIEDAD sobre una grilla y no como un caso más — un ejemplo elegido a mano
 * habría vuelto a esquivarlo.
 */
describe("invariante cap ≤ maxSeparable", () => {
  const QUANTITIES = [0, 1, 2, 5, 25];
  const FULFILLED = [0, 1];
  const INVOICED = [0, 3, 25];
  const STOCKED = [0, 1, 10, 40, 88];
  const ELSEWHERE = [0, 1, 2, 20, 28, 120];
  const SIBLING = [0, 3, 30];

  it("se cumple en toda combinación de stock, reclamo ajeno, hermanas y piso", () => {
    const violations: string[] = [];
    let checked = 0;
    for (const quantity of QUANTITIES)
      for (const fulfilled of FULFILLED)
        for (const invoiced of INVOICED)
          for (const stocked of STOCKED)
            for (const elsewhere of ELSEWHERE)
              for (const sibling of SIBLING) {
                const lines: SeparationLineInput[] = [
                  line({ lineId: "l1", quantity, fulfilled, invoiced }),
                  // Una hermana del MISMO inventory item con su separación ya
                  // guardada: es demanda dura sobre las mismas unidades.
                  line({
                    lineId: "l2",
                    quantity: 100,
                    fulfilled: 0,
                    invoiced: 0,
                    separated: sibling,
                  }),
                ];
                const caps = computeSeparationCaps(lines, stock(stocked, elsewhere));
                for (const cap of caps) {
                  checked += 1;
                  if (cap.cap > cap.maxSeparable) {
                    violations.push(
                      `${cap.lineId} qty=${quantity} ful=${fulfilled} inv=${invoiced} stock=${stocked} else=${elsewhere} sib=${sibling}: cap ${cap.cap} > max ${cap.maxSeparable}`
                    );
                  }
                }
              }
    expect(violations.slice(0, 5)).toEqual([]);
    // Sin esto, un cambio que vacíe la grilla dejaría el test pasando en cero.
    expect(checked).toBe(
      QUANTITIES.length *
        FULFILLED.length *
        INVOICED.length *
        STOCKED.length *
        ELSEWHERE.length *
        SIBLING.length *
        2
    );
  });

  it("lo que el botón masivo escribe nunca supera lo que la ruta autoriza", () => {
    // El mismo invariante dicho como lo vive el operador: se toma el valor que
    // `separateAll` pondría en la fila y se le pregunta a la validación de la
    // ruta — que es el POST real, no una reimplementación.
    for (const stocked of STOCKED)
      for (const elsewhere of ELSEWHERE)
        for (const quantity of [1, 2, 5, 25]) {
          const lines = [line({ quantity, invoiced: 0, separated: 0 })];
          const [cap] = computeSeparationCaps(lines, stock(stocked, elsewhere));
          const whatTheButtonWrites = Math.max(
            cap.invoicedFloor,
            Math.min(cap.openQty, cap.cap)
          );
          const out = validateSeparationRequest(
            lines,
            stock(stocked, elsewhere),
            new Map([["l1", whatTheButtonWrites]])
          );
          expect({
            stocked,
            elsewhere,
            quantity,
            wrote: whatTheButtonWrites,
            rejections: out,
          }).toMatchObject({ rejections: [] });
        }
  });
});
