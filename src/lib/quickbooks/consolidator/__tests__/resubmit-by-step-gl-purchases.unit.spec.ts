/**
 * Unit coverage for the 4 gl-purchases-v2 dispatch cases added to
 * `resubmit-by-step.ts` (vendor_credit_add|vendor_credit_void|
 * bill_payment_add|bill_payment_void). Bridge and DB are fully mocked — this
 * never opens a socket or a connection, on top of the sandbox exercise
 * proving the same for the real short-circuit.
 */
import type { MedusaContainer } from "@medusajs/framework/types";

const mockQuery = jest.fn();
jest.mock("../../../../api/utils/db-pool", () => ({
  getDbPool: () => ({ query: mockQuery }),
}));

const mockBridgeFetch = jest.fn();
jest.mock("../../client/core", () => ({
  bridgeFetch: (...args: unknown[]) => mockBridgeFetch(...args),
}));

const mockLoadVendorCreditAddFacts = jest.fn();
jest.mock("../../../purchase-orders/qb-vendor-credit-enqueue", () => ({
  loadVendorCreditAddFacts: (...args: unknown[]) =>
    mockLoadVendorCreditAddFacts(...args),
}));

const mockLoadBillPaymentAddFacts = jest.fn();
jest.mock("../../../purchase-orders/qb-bill-payment-enqueue", () => ({
  loadBillPaymentAddFacts: (...args: unknown[]) =>
    mockLoadBillPaymentAddFacts(...args),
}));

const mockDeferPipelineRow = jest.fn();
const mockFailPipelineRow = jest.fn();
const mockFailOrRetryPipelineRow = jest.fn();
jest.mock("../../pipeline/row-mutations", () => ({
  deferPipelineRow: (...args: unknown[]) => mockDeferPipelineRow(...args),
  failPipelineRow: (...args: unknown[]) => mockFailPipelineRow(...args),
  failOrRetryPipelineRow: (...args: unknown[]) =>
    mockFailOrRetryPipelineRow(...args),
}));

import { resubmitByStep, type ResubmitRow } from "../resubmit-by-step";

const fakeContainer = {
  resolve: () => ({}),
} as unknown as MedusaContainer;
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function baseRow(overrides: Partial<ResubmitRow>): ResubmitRow {
  return {
    id: "row_1",
    order_id: null,
    reference_id: "vcr_1",
    reference_type: "vendor_credit",
    step: "vendor_credit_add",
    qb_txn_id: null,
    retry_count: 0,
    payload: {},
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("resubmitByStep — vendor_credit_add", () => {
  it("defers (does not submit) when the credit is not ready", async () => {
    mockLoadVendorCreditAddFacts.mockResolvedValue({
      ready: false,
      reason: "the vendor has not synced to QuickBooks yet",
    });
    const row = baseRow({ step: "vendor_credit_add" });

    await resubmitByStep(row, fakeContainer, logger);

    expect(mockDeferPipelineRow).toHaveBeenCalledTimes(1);
    expect(mockDeferPipelineRow.mock.calls[0][0]).toBe("row_1");
    expect(mockBridgeFetch).not.toHaveBeenCalled();
  });

  it("submits exactly once when ready, and stores the bridge operation id", async () => {
    mockLoadVendorCreditAddFacts.mockResolvedValue({
      ready: true,
      qbxml: "<VendorCreditAddRq/>",
    });
    mockBridgeFetch.mockResolvedValue({ operationId: "op_123" });
    const row = baseRow({ step: "vendor_credit_add" });

    await resubmitByStep(row, fakeContainer, logger);

    expect(mockBridgeFetch).toHaveBeenCalledTimes(1);
    expect(mockBridgeFetch).toHaveBeenCalledWith(
      "POST",
      "/api/sync/direct-query",
      { qbxml: "<VendorCreditAddRq/>" },
      { idempotencyKey: "vendor-credit-add:row_1" }
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'submitted'"),
      ["row_1", "op_123"]
    );
    expect(mockFailPipelineRow).not.toHaveBeenCalled();
  });

  it("marks the row terminally failed (never re-enqueued) when the bridge call throws", async () => {
    mockLoadVendorCreditAddFacts.mockResolvedValue({
      ready: true,
      qbxml: "<VendorCreditAddRq/>",
    });
    mockBridgeFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const row = baseRow({ step: "vendor_credit_add" });

    await resubmitByStep(row, fakeContainer, logger);

    expect(mockFailPipelineRow).toHaveBeenCalledWith("row_1", "ECONNREFUSED");
    expect(mockFailOrRetryPipelineRow).not.toHaveBeenCalled();
  });
});

describe("resubmitByStep — vendor_credit_void", () => {
  it("waits (never voids) when the credit has no qb_txn_id yet", async () => {
    const row = baseRow({ step: "vendor_credit_void", qb_txn_id: null });

    await resubmitByStep(row, fakeContainer, logger);

    expect(mockDeferPipelineRow).toHaveBeenCalledTimes(1);
    expect(mockBridgeFetch).not.toHaveBeenCalled();
  });

  it("submits a TxnVoidRq once the credit has a qb_txn_id", async () => {
    mockBridgeFetch.mockResolvedValue({ operationId: "op_456" });
    const row = baseRow({ step: "vendor_credit_void", qb_txn_id: "9000ABC" });

    await resubmitByStep(row, fakeContainer, logger);

    expect(mockBridgeFetch).toHaveBeenCalledTimes(1);
    const [, , body] = mockBridgeFetch.mock.calls[0];
    expect((body as { qbxml: string }).qbxml).toContain(
      "<TxnVoidType>VendorCredit</TxnVoidType><TxnID>9000ABC</TxnID>"
    );
  });
});

describe("resubmitByStep — bill_payment_add", () => {
  it("defers when loadBillPaymentAddFacts reports blocking references", async () => {
    mockLoadBillPaymentAddFacts.mockResolvedValue({
      ready: false,
      reason: "waiting on QuickBooks TxnID for: vb_1",
      blockingReferenceIds: ["vb_1"],
    });
    const row = baseRow({
      step: "bill_payment_add",
      reference_id: "vbp_1",
      reference_type: "bill_payment",
    });

    await resubmitByStep(row, fakeContainer, logger);

    expect(mockDeferPipelineRow).toHaveBeenCalledTimes(1);
    expect(mockBridgeFetch).not.toHaveBeenCalled();
  });

  it("submits exactly once when ready", async () => {
    mockLoadBillPaymentAddFacts.mockResolvedValue({
      ready: true,
      qbxml: "<BillPaymentCheckAddRq/>",
      isCreditCard: false,
      blockingReferenceIds: [],
    });
    mockBridgeFetch.mockResolvedValue({ operationId: "op_789" });
    const row = baseRow({
      step: "bill_payment_add",
      reference_id: "vbp_1",
      reference_type: "bill_payment",
    });

    await resubmitByStep(row, fakeContainer, logger);

    expect(mockBridgeFetch).toHaveBeenCalledTimes(1);
    expect(mockFailPipelineRow).not.toHaveBeenCalled();
  });

  it("fails terminally (no auto-retry) when the bridge does not return an operation id", async () => {
    mockLoadBillPaymentAddFacts.mockResolvedValue({
      ready: true,
      qbxml: "<BillPaymentCheckAddRq/>",
      isCreditCard: false,
      blockingReferenceIds: [],
    });
    mockBridgeFetch.mockResolvedValue({});
    const row = baseRow({
      step: "bill_payment_add",
      reference_id: "vbp_1",
      reference_type: "bill_payment",
    });

    await resubmitByStep(row, fakeContainer, logger);

    expect(mockFailPipelineRow).toHaveBeenCalledTimes(1);
    expect(mockFailOrRetryPipelineRow).not.toHaveBeenCalled();
  });
});

describe("resubmitByStep — bill_payment_void", () => {
  it("waits when the payment has no qb_txn_id yet", async () => {
    const row = baseRow({
      step: "bill_payment_void",
      reference_id: "vbp_1",
      reference_type: "bill_payment",
      qb_txn_id: null,
    });

    await resubmitByStep(row, fakeContainer, logger);

    expect(mockDeferPipelineRow).toHaveBeenCalledTimes(1);
    expect(mockBridgeFetch).not.toHaveBeenCalled();
  });

  it("submits BillPaymentCheck TxnVoidRq for a Bank account", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ account_type: "Bank" }] });
    mockBridgeFetch.mockResolvedValue({ operationId: "op_999" });
    const row = baseRow({
      step: "bill_payment_void",
      reference_id: "vbp_1",
      reference_type: "bill_payment",
      qb_txn_id: "9000XYZ",
    });

    await resubmitByStep(row, fakeContainer, logger);

    const [, , body] = mockBridgeFetch.mock.calls[0];
    expect((body as { qbxml: string }).qbxml).toContain(
      "<TxnVoidType>BillPaymentCheck</TxnVoidType>"
    );
  });

  it("submits BillPaymentCreditCard TxnVoidRq for a CreditCard account", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ account_type: "CreditCard" }] });
    mockBridgeFetch.mockResolvedValue({ operationId: "op_999" });
    const row = baseRow({
      step: "bill_payment_void",
      reference_id: "vbp_1",
      reference_type: "bill_payment",
      qb_txn_id: "9000XYZ",
    });

    await resubmitByStep(row, fakeContainer, logger);

    const [, , body] = mockBridgeFetch.mock.calls[0];
    expect((body as { qbxml: string }).qbxml).toContain(
      "<TxnVoidType>BillPaymentCreditCard</TxnVoidType>"
    );
  });
});
