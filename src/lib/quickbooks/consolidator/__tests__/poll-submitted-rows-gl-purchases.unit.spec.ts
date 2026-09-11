/**
 * Confirmation-path coverage for the 4 gl-purchases-v2 steps in
 * `poll-submitted-rows.ts`: parses VendorCreditRet/BillPaymentCheckRet/
 * BillPaymentCreditCardRet/TxnVoidRs from the SAME `QBXMLMsgsRs` envelope
 * `qb-terms-add.ts`'s raw passthrough already documents, and calls the 4
 * write-back handlers. Bridge and DB fully mocked.
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

const mockHandleVendorCreditAddConfirmed = jest.fn();
jest.mock("../../handlers/handle-vendor-credit-add", () => ({
  handleVendorCreditAddConfirmed: (...args: unknown[]) =>
    mockHandleVendorCreditAddConfirmed(...args),
}));
const mockHandleVendorCreditVoidConfirmed = jest.fn();
jest.mock("../../handlers/handle-vendor-credit-void", () => ({
  handleVendorCreditVoidConfirmed: (...args: unknown[]) =>
    mockHandleVendorCreditVoidConfirmed(...args),
}));
const mockHandleBillPaymentAddConfirmed = jest.fn();
jest.mock("../../handlers/handle-bill-payment-add", () => ({
  handleBillPaymentAddConfirmed: (...args: unknown[]) =>
    mockHandleBillPaymentAddConfirmed(...args),
}));
const mockHandleBillPaymentVoidConfirmed = jest.fn();
jest.mock("../../handlers/handle-bill-payment-void", () => ({
  handleBillPaymentVoidConfirmed: (...args: unknown[]) =>
    mockHandleBillPaymentVoidConfirmed(...args),
}));

const mockFailPipelineRow = jest.fn();
const mockFailOrRetryPipelineRow = jest.fn();
jest.mock("../../pipeline/row-mutations", () => {
  const actual = jest.requireActual("../../pipeline/row-mutations");
  return {
    ...actual,
    failPipelineRow: (...args: unknown[]) => mockFailPipelineRow(...args),
    failOrRetryPipelineRow: (...args: unknown[]) =>
      mockFailOrRetryPipelineRow(...args),
  };
});

import { pollSubmittedRows, type SubmittedRow } from "../poll-submitted-rows";

const fakeContainer = { resolve: () => ({}) } as unknown as MedusaContainer;
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function baseRow(overrides: Partial<SubmittedRow>): SubmittedRow {
  return {
    id: "row_1",
    order_id: null,
    reference_id: "vcr_1",
    reference_type: "vendor_credit",
    step: "vendor_credit_add",
    bridge_op_id: "op_1",
    retry_count: 0,
    qb_txn_id: null,
    payload: {},
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // confirmPipelineRow's UPDATE ... RETURNING id — one row = "won the CAS".
  mockQuery.mockResolvedValue({ rows: [{ id: "row_1" }], rowCount: 1 });
});

describe("pollSubmittedRows — vendor_credit_add confirmation", () => {
  it("writes qb_txn_id via the handler on a successful VendorCreditRet", async () => {
    mockBridgeFetch.mockResolvedValue({
      operation: {
        status: "completed",
        result: {
          QBXML: {
            QBXMLMsgsRs: {
              VendorCreditAddRs: {
                statusCode: "0",
                statusMessage: "Status OK",
                VendorCreditRet: { TxnID: "9000AAA", EditSequence: "123" },
              },
            },
          },
        },
      },
    });
    const row = baseRow({ step: "vendor_credit_add" });

    await pollSubmittedRows([row], fakeContainer, logger);

    expect(mockHandleVendorCreditAddConfirmed).toHaveBeenCalledTimes(1);
    const [, creditId, ret] = mockHandleVendorCreditAddConfirmed.mock.calls[0];
    expect(creditId).toBe("vcr_1");
    expect(ret).toEqual({ TxnID: "9000AAA", EditSequence: "123" });
    expect(mockFailPipelineRow).not.toHaveBeenCalled();
  });

  it("fails terminally (never auto-retries) when QuickBooks rejects the ADD", async () => {
    mockBridgeFetch.mockResolvedValue({
      operation: {
        status: "completed",
        result: {
          QBXML: {
            QBXMLMsgsRs: {
              VendorCreditAddRs: {
                statusCode: "3000",
                statusMessage: "The given object ID is invalid",
              },
            },
          },
        },
      },
    });
    const row = baseRow({ step: "vendor_credit_add" });

    await pollSubmittedRows([row], fakeContainer, logger);

    expect(mockFailPipelineRow).toHaveBeenCalledTimes(1);
    expect(mockFailOrRetryPipelineRow).not.toHaveBeenCalled();
    expect(mockHandleVendorCreditAddConfirmed).not.toHaveBeenCalled();
  });
});

describe("pollSubmittedRows — vendor_credit_void confirmation", () => {
  it("calls the void handler on a successful TxnVoidRs", async () => {
    mockBridgeFetch.mockResolvedValue({
      operation: {
        status: "completed",
        result: {
          QBXML: { QBXMLMsgsRs: { TxnVoidRs: { statusCode: "0" } } },
        },
      },
    });
    const row = baseRow({ step: "vendor_credit_void", qb_txn_id: "9000AAA" });

    await pollSubmittedRows([row], fakeContainer, logger);

    expect(mockHandleVendorCreditVoidConfirmed).toHaveBeenCalledTimes(1);
    expect(mockFailOrRetryPipelineRow).not.toHaveBeenCalled();
  });

  it("routes a rejected void through the normal retry path (TxnVoid can't duplicate)", async () => {
    mockBridgeFetch.mockResolvedValue({
      operation: {
        status: "completed",
        result: {
          QBXML: {
            QBXMLMsgsRs: {
              TxnVoidRs: { statusCode: "3110", statusMessage: "cannot void" },
            },
          },
        },
      },
    });
    const row = baseRow({ step: "vendor_credit_void", qb_txn_id: "9000AAA" });

    await pollSubmittedRows([row], fakeContainer, logger);

    expect(mockFailOrRetryPipelineRow).toHaveBeenCalledTimes(1);
    expect(mockFailPipelineRow).not.toHaveBeenCalled();
    expect(mockHandleVendorCreditVoidConfirmed).not.toHaveBeenCalled();
  });
});

describe("pollSubmittedRows — bill_payment_add confirmation", () => {
  it("writes qb_txn_id via the handler on a successful BillPaymentCheckRet", async () => {
    mockBridgeFetch.mockResolvedValue({
      operation: {
        status: "completed",
        result: {
          QBXML: {
            QBXMLMsgsRs: {
              BillPaymentCheckAddRs: {
                statusCode: "0",
                BillPaymentCheckRet: { TxnID: "9000BBB", EditSequence: "1" },
              },
            },
          },
        },
      },
    });
    const row = baseRow({
      step: "bill_payment_add",
      reference_id: "vbp_1",
      reference_type: "bill_payment",
    });

    await pollSubmittedRows([row], fakeContainer, logger);

    expect(mockHandleBillPaymentAddConfirmed).toHaveBeenCalledTimes(1);
    const [, paymentId, ret] = mockHandleBillPaymentAddConfirmed.mock.calls[0];
    expect(paymentId).toBe("vbp_1");
    expect(ret).toEqual({ TxnID: "9000BBB", EditSequence: "1" });
  });

  it("writes qb_txn_id via the handler on a successful BillPaymentCreditCardRet", async () => {
    mockBridgeFetch.mockResolvedValue({
      operation: {
        status: "completed",
        result: {
          QBXML: {
            QBXMLMsgsRs: {
              BillPaymentCreditCardAddRs: {
                statusCode: "0",
                BillPaymentCreditCardRet: { TxnID: "9000CCC" },
              },
            },
          },
        },
      },
    });
    const row = baseRow({
      step: "bill_payment_add",
      reference_id: "vbp_1",
      reference_type: "bill_payment",
    });

    await pollSubmittedRows([row], fakeContainer, logger);

    expect(mockHandleBillPaymentAddConfirmed).toHaveBeenCalledTimes(1);
    const [, , ret] = mockHandleBillPaymentAddConfirmed.mock.calls[0];
    expect(ret).toEqual({ TxnID: "9000CCC" });
  });
});

describe("pollSubmittedRows — bill_payment_void confirmation", () => {
  it("calls the void handler on a successful TxnVoidRs", async () => {
    mockBridgeFetch.mockResolvedValue({
      operation: {
        status: "completed",
        result: {
          QBXML: { QBXMLMsgsRs: { TxnVoidRs: { statusCode: "0" } } },
        },
      },
    });
    const row = baseRow({
      step: "bill_payment_void",
      reference_id: "vbp_1",
      reference_type: "bill_payment",
      qb_txn_id: "9000BBB",
    });

    await pollSubmittedRows([row], fakeContainer, logger);

    expect(mockHandleBillPaymentVoidConfirmed).toHaveBeenCalledTimes(1);
  });
});
