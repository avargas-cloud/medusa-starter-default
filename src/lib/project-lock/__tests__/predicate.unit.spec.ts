import { linksFromOrderMetadata, mergeLinks } from "../links";
import { lockReasonFromFacts, receivedCentsOf } from "../predicate";
import type { OrderSettlementFacts } from "../types";

const base: OrderSettlementFacts = {
  orderId: "order_1",
  exists: true,
  isDraftOrder: false,
  deleted: false,
  projectionReceivedCents: 0,
  capturedCents: 0,
  fulfilledUnits: 0,
};

describe("lockReasonFromFacts — el mismo predicado que orderSyncBlockReason del POS", () => {
  it("sin dinero ni entregas no lockea", () => {
    expect(lockReasonFromFacts(base)).toBeNull();
  });

  it("un centavo recibido (proyección) → paid", () => {
    expect(lockReasonFromFacts({ ...base, projectionReceivedCents: 1 })).toBe("paid");
  });

  it("un centavo capturado nativo (orden web antes de recomputar) → paid", () => {
    expect(lockReasonFromFacts({ ...base, capturedCents: 1 })).toBe("paid");
  });

  it("recibido = MAX de las dos lecturas, nunca la suma", () => {
    expect(receivedCentsOf({ ...base, projectionReceivedCents: 500, capturedCents: 500 })).toBe(
      500
    );
    expect(receivedCentsOf({ ...base, projectionReceivedCents: 200, capturedCents: 900 })).toBe(
      900
    );
  });

  it("unidades entregadas ganan sobre el dinero: fulfilled", () => {
    expect(
      lockReasonFromFacts({ ...base, projectionReceivedCents: 1000, fulfilledUnits: 2 })
    ).toBe("fulfilled");
  });

  it("un estimate (draft order) nunca lockea aunque tenga depósito", () => {
    expect(
      lockReasonFromFacts({ ...base, isDraftOrder: true, projectionReceivedCents: 5000 })
    ).toBeNull();
  });

  it("una orden borrada o inexistente nunca lockea", () => {
    expect(lockReasonFromFacts({ ...base, deleted: true, capturedCents: 100 })).toBeNull();
    expect(lockReasonFromFacts({ ...base, exists: false, capturedCents: 100 })).toBeNull();
  });
});

describe("linksFromOrderMetadata — las claves que escribe el POS al vincular", () => {
  it("lee backlighting_project_id y ll_project_id", () => {
    expect(
      linksFromOrderMetadata({
        backlighting_project_id: "proj_1",
        ll_project_id: "llp_2",
        other: "x",
      })
    ).toEqual([
      { app: "backlighting", projectId: "proj_1" },
      { app: "linear-lighting", projectId: "llp_2" },
    ]);
  });

  it("ignora metadata nula, vacía o con ids no-string", () => {
    expect(linksFromOrderMetadata(null)).toEqual([]);
    expect(linksFromOrderMetadata({})).toEqual([]);
    expect(linksFromOrderMetadata({ backlighting_project_id: 42 })).toEqual([]);
    expect(linksFromOrderMetadata({ ll_project_id: "  " })).toEqual([]);
  });

  it("mergeLinks deduplica por (app, project)", () => {
    expect(
      mergeLinks(
        [{ app: "backlighting", projectId: "p1" }],
        [
          { app: "backlighting", projectId: "p1" },
          { app: "linear-lighting", projectId: "p1" },
        ]
      )
    ).toEqual([
      { app: "backlighting", projectId: "p1" },
      { app: "linear-lighting", projectId: "p1" },
    ]);
  });
});
