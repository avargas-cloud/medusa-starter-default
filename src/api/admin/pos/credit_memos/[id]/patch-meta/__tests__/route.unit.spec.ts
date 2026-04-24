/**
 * Unit tests for PATCH /admin/pos/credit_memos/:id/patch-meta
 *
 * Type: mock-based unit test (no DB, no QB bridge, no Medusa service calls)
 * All external dependencies replaced with jest mocks / stubs.
 */

// ─── Mock external deps BEFORE importing the route ───────────────────────────

jest.mock(
  "../../../../../../../lib/quickbooks/qb-pipeline",
  () => ({ writePipelineRow: jest.fn().mockResolvedValue("pipeline-row-id") })
);

jest.mock(
  "../../../../../../../lib/quickbooks/client/credit-memos",
  () => ({ updateCreditMemoInQb: jest.fn() })
);

jest.mock(
  "../../../../../../../lib/quickbooks/qb-config",
  () => ({ getQbConfig: jest.fn() })
);

jest.mock(
  "../../../../../../../modules/credit_memos",
  () => ({ CREDIT_MEMO_MODULE: "CREDIT_MEMO_MODULE" })
);

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { PATCH } from "../route";
import { writePipelineRow } from "../../../../../../../lib/quickbooks/qb-pipeline";
import { updateCreditMemoInQb } from "../../../../../../../lib/quickbooks/client/credit-memos";
import { getQbConfig } from "../../../../../../../lib/quickbooks/qb-config";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockWritePipeline = writePipelineRow as jest.MockedFunction<typeof writePipelineRow>;
const mockUpdateCm = updateCreditMemoInQb as jest.MockedFunction<typeof updateCreditMemoInQb>;
const mockGetQbConfig = getQbConfig as jest.MockedFunction<typeof getQbConfig>;

function buildMemo(overrides: Record<string, unknown> = {}) {
  return {
    id: "cm-001",
    credit_memo_number: "CM-20001",
    status: "completed",
    subtotal: 10000,   // cents
    tax: 700,
    shipping: 0,
    total: 10700,
    sales_rep: null,
    qb_txn_id: "QB-CM-TXN-001",
    qb_edit_sequence: "1234567890",
    ...overrides,
  };
}

function buildReq(body: Record<string, unknown>, memo: Record<string, unknown>) {
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
  } as unknown as Parameters<typeof PATCH>[0] & { _service: typeof creditMemoService };
}

function buildRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json, _status: status, _json: json } as unknown as Parameters<typeof PATCH>[1] & {
    _status: jest.Mock;
    _json: jest.Mock;
  };
}

// Flush all pending microtasks (fire-and-forget promises)
const flushPromises = () => new Promise((r) => setTimeout(r, 0));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PATCH /admin/pos/credit_memos/:id/patch-meta", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, QB_ORDER_FLOW_ENABLED: "true" };
    mockWritePipeline.mockResolvedValue("pipeline-row-id");
    mockGetQbConfig.mockResolvedValue({ defaultSalesTaxCode: "Sale Tax 7%" } as any);
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
    const req = buildReq({ sales_rep: { initials: "AV", name: "Alex" } }, buildMemo());
    (req._service as any).listPosCreditMemos.mockResolvedValue([]);
    const res = buildRes();
    await PATCH(req, res);
    expect(res._status).toHaveBeenCalledWith(404);
  });

  // ── 2. Sales rep only ─────────────────────────────────────────────────────

  it("saves sales_rep and fires credit_memo_mod pipeline with salesRepRef", async () => {
    const req = buildReq(
      { sales_rep: { initials: "AV", name: "Alex Vargas" } },
      buildMemo()
    );
    const res = buildRes();
    mockUpdateCm.mockResolvedValue({ success: true, data: { operationId: "op-123" } });

    await PATCH(req, res);
    await flushPromises();

    expect(res._status).toHaveBeenCalledWith(200);
    expect((req._service as any).updatePosCreditMemos).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cm-001", sales_rep: { initials: "AV", name: "Alex Vargas" } })
    );
    expect(mockWritePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ step: "credit_memo_mod", status: "pending", referenceId: "cm-001" })
    );
    expect(mockUpdateCm).toHaveBeenCalledWith(
      expect.objectContaining({ txnId: "QB-CM-TXN-001", editSequence: "1234567890", salesRepRef: "Alex Vargas" })
    );
    expect(mockWritePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ step: "credit_memo_mod", status: "confirmed", bridgeOpId: "op-123" })
    );
  });

  it("uses initials as salesRepRef when name is absent", async () => {
    const req = buildReq(
      { sales_rep: { initials: "JD", name: "" } },
      buildMemo()
    );
    mockUpdateCm.mockResolvedValue({ success: true, data: { operationId: "op-124" } });
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    expect(mockUpdateCm).toHaveBeenCalledWith(
      expect.objectContaining({ salesRepRef: "JD" })
    );
  });

  it("clears sales_rep (sets to null) without sending salesRepRef to QB", async () => {
    const req = buildReq({ sales_rep: null }, buildMemo());
    mockUpdateCm.mockResolvedValue({ success: true, data: { operationId: "op-125" } });
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    // sales_rep: null → salesRepRef becomes undefined → NOT included in QB payload
    expect(mockUpdateCm).toHaveBeenCalledWith(
      expect.not.objectContaining({ salesRepRef: expect.anything() })
    );
  });

  // ── 3. Tax mode ───────────────────────────────────────────────────────────

  it("fires credit_memo_mod with salesTaxCode for tax_mode=florida", async () => {
    const req = buildReq({ tax_mode: "florida", subtotal: 10000 }, buildMemo());
    mockUpdateCm.mockResolvedValue({ success: true, data: { operationId: "op-200" } });
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    expect(mockGetQbConfig).toHaveBeenCalled();
    expect(mockUpdateCm).toHaveBeenCalledWith(
      expect.objectContaining({ salesTaxCode: "Sale Tax 7%" })
    );
    expect(mockUpdateCm).not.toHaveBeenCalledWith(
      expect.objectContaining({ taxExempt: true })
    );
  });

  it("fires credit_memo_mod with taxExempt=true for tax_mode=exempt", async () => {
    const req = buildReq({ tax_mode: "exempt", subtotal: 10000 }, buildMemo({ tax: 700, total: 10700 }));
    mockUpdateCm.mockResolvedValue({ success: true, data: { operationId: "op-201" } });
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    expect(mockGetQbConfig).not.toHaveBeenCalled();
    expect(mockUpdateCm).toHaveBeenCalledWith(
      expect.objectContaining({ taxExempt: true })
    );
    expect(mockUpdateCm).not.toHaveBeenCalledWith(
      expect.objectContaining({ salesTaxCode: expect.anything() })
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
    expect(mockUpdateCm).not.toHaveBeenCalled();
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
    expect(mockUpdateCm).not.toHaveBeenCalled();
  });

  // ── 5. QB failure path ────────────────────────────────────────────────────

  it("writes pipeline row as 'failed' when updateCreditMemoInQb returns success=false", async () => {
    const req = buildReq(
      { sales_rep: { initials: "AV", name: "Alex" } },
      buildMemo()
    );
    mockUpdateCm.mockResolvedValue({ success: false, error: "EditSequence stale" });
    const res = buildRes();

    await PATCH(req, res);
    await flushPromises();

    expect(res._status).toHaveBeenCalledWith(200); // HTTP response succeeds (QB is fire-and-forget)
    expect(mockWritePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ step: "credit_memo_mod", status: "failed", error: "EditSequence stale" })
    );
  });

  it("writes pipeline row as 'failed' when updateCreditMemoInQb throws", async () => {
    const req = buildReq(
      { sales_rep: { initials: "AV", name: "Alex" } },
      buildMemo()
    );
    mockUpdateCm.mockRejectedValue(new Error("Bridge unreachable"));
    const res = buildRes();

    await PATCH(req, res);
    await flushPromises();

    expect(mockWritePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: "Bridge unreachable" })
    );
  });

  // ── 6. Payment guard ──────────────────────────────────────────────────────

  it("returns 409 and does NOT fire QB pipeline when tax reduction undercuts applied credit", async () => {
    const req = buildReq({ tax_mode: "exempt", subtotal: 10000 }, buildMemo({ tax: 700, total: 10700 }));

    // Simulate a payment that has $8000 cents already applied
    const pgConnection = jest.fn().mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: "pay-001" }),
      sum: jest.fn().mockReturnThis(),
      update: jest.fn().mockResolvedValue(1),
    }));

    // Override sum().first() to return large applied total
    let callDepth = 0;
    pgConnection.mockImplementation(() => {
      callDepth++;
      return {
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(
          callDepth === 1 ? { id: "pay-001" } : { total: "15000" } // 150.00 already applied, new total is 100.00
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
    expect(mockUpdateCm).not.toHaveBeenCalled();
  });

  // ── 7. Combined sales_rep + tax_mode ──────────────────────────────────────

  it("includes both salesRepRef and salesTaxCode when both fields are changed simultaneously", async () => {
    const req = buildReq(
      { sales_rep: { initials: "AV", name: "Alex" }, tax_mode: "florida", subtotal: 10000 },
      buildMemo()
    );
    mockUpdateCm.mockResolvedValue({ success: true, data: { operationId: "op-300" } });
    const res = buildRes();
    await PATCH(req, res);
    await flushPromises();

    expect(mockUpdateCm).toHaveBeenCalledWith(
      expect.objectContaining({ salesRepRef: "Alex", salesTaxCode: "Sale Tax 7%" })
    );
  });

  // ── 8. Pipeline uses correct reference fields ─────────────────────────────

  it("pipeline row references the CM id and credit_memo_number", async () => {
    const req = buildReq(
      { sales_rep: { initials: "AV", name: "Alex" } },
      buildMemo({ credit_memo_number: "CM-20099" })
    );
    mockUpdateCm.mockResolvedValue({ success: true, data: { operationId: "op-400" } });
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
