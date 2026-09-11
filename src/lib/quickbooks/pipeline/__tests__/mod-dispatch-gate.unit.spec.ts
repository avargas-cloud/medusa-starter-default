/**
 * Unit coverage for the mod dispatch gate (2026-09-11): `decideModDispatch`
 * is the pure ordering rule (oldest in-flight sibling on the document goes
 * first, everyone younger defers) and `gateModDispatch` is its IO wrapper.
 * See mod-dispatch-gate.ts's header comment for the why (5-minute worker
 * freeze this replaces).
 */
import type { InFlightSibling } from "../mod-dispatch-gate";

// Hoisted mocks for the whole file — `decideModDispatch` never touches
// either module, so they're inert there; `gateModDispatch` below is what
// actually exercises them.
const mockQuery = jest.fn();
jest.mock("../../../../api/utils/db-pool", () => ({
  getDbPool: () => ({ query: mockQuery }),
}));

const mockDeferPipelineRow = jest.fn();
jest.mock("../row-mutations", () => ({
  deferPipelineRow: (...args: unknown[]) => mockDeferPipelineRow(...args),
}));

import { decideModDispatch, gateModDispatch } from "../mod-dispatch-gate";

describe("decideModDispatch", () => {
  const OWN_ID = "row_own";

  it("dispatches when there is no in-flight sibling", () => {
    const decision = decideModDispatch({
      ownRowId: OWN_ID,
      ownCreatedAt: new Date("2026-09-11T10:00:00Z"),
      inFlight: null,
    });
    expect(decision.action).toBe("dispatch");
  });

  it("dispatches when the only in-flight row IS this row", () => {
    const inFlight: InFlightSibling = {
      id: OWN_ID,
      status: "processing",
      created_at: new Date("2026-09-11T10:00:00Z"),
    };
    const decision = decideModDispatch({
      ownRowId: OWN_ID,
      ownCreatedAt: new Date("2026-09-11T10:00:00Z"),
      inFlight,
    });
    expect(decision.action).toBe("dispatch");
  });

  it("defers behind an OLDER sibling (Date inputs)", () => {
    const inFlight: InFlightSibling = {
      id: "row_older",
      status: "submitted",
      created_at: new Date("2026-09-11T09:00:00Z"),
    };
    const decision = decideModDispatch({
      ownRowId: OWN_ID,
      ownCreatedAt: new Date("2026-09-11T10:00:00Z"),
      inFlight,
    });
    expect(decision).toMatchObject({ action: "defer", behindRowId: "row_older" });
  });

  it("dispatches ahead of a YOUNGER sibling (ISO-string inputs)", () => {
    const inFlight: InFlightSibling = {
      id: "row_younger",
      status: "processing",
      created_at: "2026-09-11T11:00:00Z",
    };
    const decision = decideModDispatch({
      ownRowId: OWN_ID,
      ownCreatedAt: "2026-09-11T10:00:00Z",
      inFlight,
    });
    expect(decision.action).toBe("dispatch");
  });

  it("tie on created_at: dispatches when own id sorts lexically LOWER", () => {
    const sameTs = "2026-09-11T10:00:00Z";
    const inFlight: InFlightSibling = {
      id: "row_zzz",
      status: "processing",
      created_at: sameTs,
    };
    const decision = decideModDispatch({
      ownRowId: "row_aaa",
      ownCreatedAt: sameTs,
      inFlight,
    });
    expect(decision.action).toBe("dispatch");
  });

  it("tie on created_at: defers when own id sorts lexically HIGHER", () => {
    const sameTs = "2026-09-11T10:00:00Z";
    const inFlight: InFlightSibling = {
      id: "row_aaa",
      status: "processing",
      created_at: sameTs,
    };
    const decision = decideModDispatch({
      ownRowId: "row_zzz",
      ownCreatedAt: sameTs,
      inFlight,
    });
    expect(decision).toMatchObject({ action: "defer", behindRowId: "row_aaa" });
  });

  it("defers when ownCreatedAt is null (unknown ordering yields)", () => {
    const inFlight: InFlightSibling = {
      id: "row_other",
      status: "processing",
      created_at: "2026-09-11T10:00:00Z",
    };
    const decision = decideModDispatch({
      ownRowId: OWN_ID,
      ownCreatedAt: null,
      inFlight,
    });
    expect(decision).toMatchObject({ action: "defer", behindRowId: "row_other" });
  });

  it("defers when the sibling's created_at is an invalid string", () => {
    const inFlight: InFlightSibling = {
      id: "row_other",
      status: "processing",
      created_at: "not-a-date",
    };
    const decision = decideModDispatch({
      ownRowId: OWN_ID,
      ownCreatedAt: new Date("2026-09-11T10:00:00Z"),
      inFlight,
    });
    expect(decision).toMatchObject({ action: "defer", behindRowId: "row_other" });
  });
});

describe("gateModDispatch", () => {
  const ROW_ID = "row_1";
  const ORDER_ID = "order_1";
  const STEPS = ["sales_order", "sales_order_mod"];
  const STEP = "sales_order_mod";
  const logger = { info: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDeferPipelineRow.mockResolvedValue({ deferredSince: null });
  });

  function mockQueryImplementation(siblingRows: unknown[]) {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT created_at FROM qb_order_pipeline")) {
        return Promise.resolve({
          rows: [{ created_at: "2026-09-11T10:00:00Z" }],
        });
      }
      if (sql.includes("ORDER BY created_at ASC")) {
        return Promise.resolve({ rows: siblingRows });
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });
  }

  it("defers behind an older in-flight sibling", async () => {
    mockQueryImplementation([
      {
        id: "row_older",
        status: "processing",
        created_at: "2026-09-11T09:00:00Z",
      },
    ]);

    const result = await gateModDispatch({
      rowId: ROW_ID,
      orderId: ORDER_ID,
      steps: STEPS,
      step: STEP,
      logger,
      logPrefix: "[TEST]",
    });

    expect(result).toBe("deferred");
    expect(mockDeferPipelineRow).toHaveBeenCalledTimes(1);
    const [rowIdArg, reasonArg, secondsArg] = mockDeferPipelineRow.mock.calls[0];
    expect(rowIdArg).toBe(ROW_ID);
    expect(reasonArg).toContain(STEP);
    expect(reasonArg).toContain("deferred");
    expect(secondsArg).toBe(60);
    expect(logger.info).toHaveBeenCalledTimes(1);

    const siblingCall = mockQuery.mock.calls.find(([sql]) =>
      sql.includes("ORDER BY created_at ASC")
    );
    expect(siblingCall?.[1]).toEqual([ORDER_ID, STEPS, ROW_ID]);
  });

  it("dispatches when there is no in-flight sibling", async () => {
    mockQueryImplementation([]);

    const result = await gateModDispatch({
      rowId: ROW_ID,
      orderId: ORDER_ID,
      steps: STEPS,
      step: STEP,
      logger,
      logPrefix: "[TEST]",
    });

    expect(result).toBe("dispatch");
    expect(mockDeferPipelineRow).not.toHaveBeenCalled();
  });

  it("dispatches ahead of a younger in-flight sibling", async () => {
    mockQueryImplementation([
      {
        id: "row_younger",
        status: "processing",
        created_at: "2026-09-11T11:00:00Z",
      },
    ]);

    const result = await gateModDispatch({
      rowId: ROW_ID,
      orderId: ORDER_ID,
      steps: STEPS,
      step: STEP,
      logger,
      logPrefix: "[TEST]",
    });

    expect(result).toBe("dispatch");
    expect(mockDeferPipelineRow).not.toHaveBeenCalled();
  });
});
