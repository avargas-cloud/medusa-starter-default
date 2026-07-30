/**
 * Unit tests for PATCH /admin/pos/credit_memos/:id/patch-meta
 *
 * Type: mock-based unit test (no DB, no QB bridge, no Medusa service calls)
 * All external dependencies replaced with jest mocks / stubs.
 *
 * ── Why this file was rewritten (2026-07-29) ─────────────────────────────────
 * Until 1.5.8 (`8040d14e`) this route called `updateCreditMemoInQb` itself and
 * wrote the pipeline row afterwards to record what the bridge answered. Credit
 * memos are now PIPELINE-ONLY: the route only enqueues a `credit_memo_mod` row
 * and the consolidator submits it (dispatch-pass → resubmit-by-step). The old
 * spec kept asserting the bridge call, so all 8 of its QB assertions failed
 * with "Number of calls: 0" — it was describing a design that no longer exists,
 * NOT a sync that had gone silent (verified against production: every
 * `credit_memo_mod` row is `confirmed`, most recently 2026-07-29).
 *
 * So the assertions now target the row that is enqueued: its step, status,
 * references, and the payload the consolidator will read.
 */

// ─── Mock external deps BEFORE importing the route ───────────────────────────

jest.mock("../../lib/quickbooks/qb-pipeline", () => ({
  writePipelineRow: jest.fn().mockResolvedValue("pipeline-row-id"),
}));

jest.mock("../../lib/quickbooks/qb-config", () => ({
  getQbConfig: jest.fn(),
}));

jest.mock("../../modules/credit_memos", () => ({
  CREDIT_MEMO_MODULE: "CREDIT_MEMO_MODULE",
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { getQbConfig } from "../../lib/quickbooks/qb-config";
import { writePipelineRow } from "../../lib/quickbooks/qb-pipeline";
import { PATCH } from "../../api/admin/pos/credit_memos/[id]/patch-meta/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockWritePipeline = writePipelineRow as jest.MockedFunction<
  typeof writePipelineRow
>;
const mockGetQbConfig = getQbConfig as jest.MockedFunction<typeof getQbConfig>;

type PipelineRowInput = Parameters<typeof writePipelineRow>[0];
type QbConfig = Awaited<ReturnType<typeof getQbConfig>>;

const QB_CONFIG = {
  defaultSalesTaxCode: "Sale Tax 7%",
  taxItemListidTaxed: "80000001-1111111111",
  taxItemListidExempt: "80000002-2222222222",
} as unknown as QbConfig;

/**
 * The route enqueues twice: a bare row that claims the step, then the row that
 * carries the mod fields. Assertions about WHAT reaches QuickBooks belong to
 * the second one.
 */
function payloadRow(): PipelineRowInput {
  const row = mockWritePipeline.mock.calls
    .map(([arg]) => arg)
    .find((arg) => arg.payload !== undefined);
  expect(row).toBeDefined();
  return row as PipelineRowInput;
}

function rowsWithStatus(status: string): PipelineRowInput[] {
  return mockWritePipeline.mock.calls
    .map(([arg]) => arg)
    .filter((arg) => arg.status === status);
}

function buildMemo(overrides: Record<string, unknown> = {}) {
  return {
    id: "cm-001",
    credit_memo_number: "CM-20001",
    status: "completed",
    subtotal: 10000, // cents
    tax: 700,
    shipping: 0,
    total: 10700,
    sales_rep: null,
    metadata: {},
    qb_txn_id: "QB-CM-TXN-001",
    qb_edit_sequence: "1234567890",
    ...overrides,
  };
}

function buildReq(
  body: Record<string, unknown>,
  memo: Record<string, unknown>
) {
  const creditMemoService = {
    listPosCreditMemos: jest.fn().mockResolvedValue([memo]),
    updatePosCreditMemos: jest.fn().mockResolvedValue({}),
  };

  const pgConnection = jest.fn().mockReturnValue({
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
    sum: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(1),
  });

  return {
    params: { id: "cm-001" },
    body,
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "CREDIT_MEMO_MODULE") return creditMemoService;
        if (key === "__pg_connection__") return pgConnection;
        return null;
      }),
    },
    _service: creditMemoService,
  } as unknown as Parameters<typeof PATCH>[0] & {
    _service: typeof creditMemoService;
  };
}

function buildRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return {
    status,
    json,
    _status: status,
    _json: json,
  } as unknown as Parameters<typeof PATCH>[1] & {
    _status: jest.Mock;
    _json: jest.Mock;
  };
}

// Flush all pending microtasks (the QB enqueue is fire-and-forget)
const flushPromises = () => new Promise((r) => setTimeout(r, 0));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PATCH /admin/pos/credit_memos/:id/patch-meta", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, QB_ORDER_FLOW_ENABLED: "true" };
    mockWritePipeline.mockResolvedValue("pipeline-row-id");
    mockGetQbConfig.mockResolvedValue(QB_CONFIG);
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  // ── 1. Validation ─────────────────────────────────────────────────────────

  it("returns 400 when body is empty (no fields provided)", async () => {
    const req = buildReq({}, buildMemo());
    const res = buildRes();
    await PATCH(req, res);
    expect(res._status).toHaveBeenCalledWith(400);
  });

  it("returns 400 for invalid tax_mode value", async () => {
    const req = buildReq({ tax_mode: "california" }, buildMemo());
    const res = buildRes();
    await PATCH(req, res);
    expect(res._status).toHaveBeenCalledWith(400);
  });

  it("returns 404 when credit memo is not found", async () => {
    const req = buildReq(
      { sales_rep: { initials: "AV", name: "Alex" } },
      buildMemo()
    );
    (req._service as { listPosCreditMemos: jest.Mock }).listPosCreditMemos.mockResolvedValue(
      []
    );
    const res = buildRes();
    await PATCH(req, res);
    expect(res._status).toHaveBeenCalledWith(404);
  });

  // ── 2. Sales rep only ─────────────────────────────────────────────────────

  it("saves sales_rep and enqueues credit_memo_mod with salesRepRef", async () => {
    const req = buildReq(
      { sales_rep: { initials: "AV", name: "Alex Vargas" } },
      buildMemo()
    );
    const res = buildRes();

    await PATCH(req, res);
    await flushPromises();

    expect(res._status).toHaveBeenCalledWith(200);
    expect(
      (req._service as { updatePosCreditMemos: jest.Mock }).updatePosCreditMemos
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cm-001",
        sales_rep: { initials: "AV", name: "Alex Vargas" },
      })
    );

    // The step is claimed as pending — nothing here talks to the bridge.
    expect(mockWritePipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "credit_memo_mod",
        status: "pending",
        referenceId: "cm-001",
      })
    );

    // ...and the mod fields ride in the payload the consolidator will submit.
    const row = payloadRow();
    expect(row.payload).toEqual({ salesRepRef: "AV" });
    // MERGE, never replace: this row is reused for the CM's whole life and may
    // already carry an edit's `items` that has not dispatched yet.
    expect(row.mergePayload).toBe(true);
    expect(rowsWithStatus("failed")).toHaveLength(0);
  });

  it("uses initials as salesRepRef when name is absent", async () => {
    const req = buildReq(
      { sales_rep: { initials: "JD", name: "" } },
      buildMemo()
    );
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    expect(payloadRow().payload).toEqual({ salesRepRef: "JD" });
  });

  it("clears sales_rep (sets to null) without sending salesRepRef to QB", async () => {
    const req = buildReq({ sales_rep: null }, buildMemo());
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    expect(
      (req._service as { updatePosCreditMemos: jest.Mock }).updatePosCreditMemos
    ).toHaveBeenCalledWith(expect.objectContaining({ sales_rep: null }));

    // parseSalesRepInitials(null) → undefined → the key is omitted entirely.
    // Consequence worth stating out loud rather than discovering later: since
    // the payload is merged and carries no rep key, clearing the rep in Medusa
    // leaves whatever rep QuickBooks already had. That is the documented
    // behavior (initials are never derived), not an oversight of this spec.
    expect(payloadRow().payload).not.toHaveProperty("salesRepRef");
  });

  // ── 3. Tax mode ───────────────────────────────────────────────────────────

  it("enqueues credit_memo_mod with salesTaxCode for tax_mode=florida", async () => {
    const req = buildReq({ tax_mode: "florida", subtotal: 10000 }, buildMemo());
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    expect(mockGetQbConfig).toHaveBeenCalled();

    const payload = payloadRow().payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      salesTaxCode: "Sale Tax 7%",
      qbTaxItemListid: "80000001-1111111111",
    });
    expect(payload).not.toHaveProperty("taxExempt");

    // The resolved ListID is also persisted on the memo so the pipeline reads
    // it directly instead of re-deriving it from the tax math (65216734).
    expect(
      (req._service as { updatePosCreditMemos: jest.Mock }).updatePosCreditMemos
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        tax: 700,
        total: 10700,
        metadata: { qb_tax_item_listid: "80000001-1111111111" },
      })
    );
  });

  it("enqueues credit_memo_mod with taxExempt=true for tax_mode=exempt", async () => {
    const req = buildReq(
      { tax_mode: "exempt", subtotal: 10000 },
      buildMemo({ tax: 700, total: 10700 })
    );
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    const payload = payloadRow().payload as Record<string, unknown>;
    expect(payload).toMatchObject({ taxExempt: true });
    expect(payload).not.toHaveProperty("salesTaxCode");

    // Tax is zeroed on the memo and the exempt ListID is persisted.
    expect(
      (req._service as { updatePosCreditMemos: jest.Mock }).updatePosCreditMemos
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        tax: 0,
        total: 10000,
        metadata: { qb_tax_item_listid: "80000002-2222222222" },
      })
    );
  });

  // ── 4. No QB sync conditions ──────────────────────────────────────────────

  it("does NOT fire pipeline when qb_txn_id is null (CM not yet in QB)", async () => {
    const req = buildReq(
      { sales_rep: { initials: "AV", name: "Alex" } },
      buildMemo({ qb_txn_id: null })
    );
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    expect(mockWritePipeline).not.toHaveBeenCalled();
    expect(res._status).toHaveBeenCalledWith(200);
  });

  it("does NOT fire pipeline when QB_ORDER_FLOW_ENABLED is not 'true'", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "false";
    const req = buildReq(
      { sales_rep: { initials: "AV", name: "Alex" } },
      buildMemo()
    );
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    expect(mockWritePipeline).not.toHaveBeenCalled();
  });

  // ── 5. Enqueue failure path ───────────────────────────────────────────────
  //
  // Pre-1.5.8 these two covered "the bridge answered success=false" and "the
  // bridge threw". With the bridge out of the route, the same two branches are
  // now reached by the enqueue chain failing — which is the only thing left
  // that can fail here, and the reason the failure is recorded as a row at all.

  it("writes pipeline row as 'failed' when the payload enqueue rejects", async () => {
    const req = buildReq(
      { sales_rep: { initials: "AV", name: "Alex" } },
      buildMemo()
    );
    mockWritePipeline
      .mockResolvedValueOnce("pipeline-row-id") // the claim succeeds
      .mockRejectedValueOnce(new Error("pipeline write conflict")); // the payload row does not
    const res = buildRes();

    await PATCH(req, res);
    await flushPromises();

    // HTTP still succeeds — the QB enqueue is fire-and-forget by design.
    expect(res._status).toHaveBeenCalledWith(200);
    expect(mockWritePipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "credit_memo_mod",
        status: "failed",
        error: "pipeline write conflict",
        qbTxnId: "QB-CM-TXN-001",
      })
    );
  });

  it("writes pipeline row as 'failed' when resolving the QB config throws", async () => {
    const req = buildReq({ tax_mode: "florida", subtotal: 10000 }, buildMemo());
    mockGetQbConfig.mockRejectedValue(new Error("QB config unreachable"));
    const res = buildRes();

    await PATCH(req, res);
    await flushPromises();

    expect(mockWritePipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: "QB config unreachable",
      })
    );
  });

  // ── 6. Payment guard ──────────────────────────────────────────────────────

  it("returns 409 and does NOT fire QB pipeline when tax reduction undercuts applied credit", async () => {
    const req = buildReq(
      { tax_mode: "exempt", subtotal: 10000 },
      buildMemo({ tax: 700, total: 10700 })
    );

    // First lookup finds the linked payment; the second returns the applied sum
    // ($150.00 already applied, above the new $100.00 total).
    let callDepth = 0;
    const pgConnection = jest.fn().mockImplementation(() => {
      callDepth++;
      return {
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        first: jest
          .fn()
          .mockResolvedValue(
            callDepth === 1 ? { id: "pay-001" } : { total: "15000" }
          ),
        sum: jest.fn().mockReturnThis(),
        update: jest.fn().mockResolvedValue(1),
      };
    });

    (req.scope.resolve as jest.Mock).mockImplementation((key: string) => {
      if (key === "CREDIT_MEMO_MODULE") return req._service;
      if (key === "__pg_connection__") return pgConnection;
      return null;
    });

    const res = buildRes();
    await PATCH(req, res);

    expect(res._status).toHaveBeenCalledWith(409);
    await flushPromises();
    expect(mockWritePipeline).not.toHaveBeenCalled();
  });

  // ── 7. Combined sales_rep + tax_mode ──────────────────────────────────────

  it("includes both salesRepRef and salesTaxCode when both fields are changed simultaneously", async () => {
    const req = buildReq(
      {
        sales_rep: { initials: "AV", name: "Alex" },
        tax_mode: "florida",
        subtotal: 10000,
      },
      buildMemo()
    );
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    expect(payloadRow().payload).toMatchObject({
      salesRepRef: "AV",
      salesTaxCode: "Sale Tax 7%",
    });
  });

  // ── 8. Pipeline uses correct reference fields ─────────────────────────────

  it("pipeline row references the CM id and credit_memo_number", async () => {
    const req = buildReq(
      { sales_rep: { initials: "AV", name: "Alex" } },
      buildMemo({ credit_memo_number: "CM-20099" })
    );
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    expect(mockWritePipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceId: "cm-001",
        referenceType: "credit_memo",
        medusaRefNumber: "CM-20099",
        qbTxnId: "QB-CM-TXN-001",
      })
    );
  });
});
