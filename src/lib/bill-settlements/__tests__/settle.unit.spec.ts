/**
 * Orchestration coverage for `settleBills` — every write it makes goes
 * through an already-tested lane (`vendor-credits/apply`, `.../create`,
 * `.../post`, `bill-payments/create`) and an already-tested QB enqueue, so
 * this spec mocks all of them and asserts only the ORCHESTRATION contract:
 * order, cut-at-first-failure, pure validation, and the shape handed to the
 * prepayment lane.
 */

const mockApplyVendorCreditToBill = jest.fn();
jest.mock("../../vendor-credits/apply", () => ({
  applyVendorCreditToBill: (...args: unknown[]) => mockApplyVendorCreditToBill(...args),
}));

const mockCreateDraftVendorCredit = jest.fn();
jest.mock("../../vendor-credits/create", () => ({
  createDraftVendorCredit: (...args: unknown[]) => mockCreateDraftVendorCredit(...args),
}));

const mockMarkVendorCreditPosted = jest.fn();
jest.mock("../../vendor-credits/post", () => ({
  markVendorCreditPosted: (...args: unknown[]) => mockMarkVendorCreditPosted(...args),
}));

const mockCreateBillPayment = jest.fn();
jest.mock("../../bill-payments/create", () => ({
  createBillPayment: (...args: unknown[]) => mockCreateBillPayment(...args),
}));

const mockEnqueueVendorCreditApply = jest.fn();
jest.mock("../../purchase-orders/qb-vendor-credit-apply-enqueue", () => ({
  enqueueVendorCreditApply: (...args: unknown[]) => mockEnqueueVendorCreditApply(...args),
}));

const mockEnqueueVendorCreditAdd = jest.fn();
jest.mock("../../purchase-orders/qb-vendor-credit-enqueue", () => ({
  enqueueVendorCreditAdd: (...args: unknown[]) => mockEnqueueVendorCreditAdd(...args),
}));

const mockEnqueueBillPaymentAdd = jest.fn();
jest.mock("../../purchase-orders/qb-bill-payment-enqueue", () => ({
  enqueueBillPaymentAdd: (...args: unknown[]) => mockEnqueueBillPaymentAdd(...args),
}));

jest.mock("../../ledger", () => ({
  postVendorCredit: jest.fn(),
  postBillPayment: jest.fn(),
}));

jest.mock("../../ledger/documents/vendor-bill-adjustment", () => ({
  postVendorBillAdjustment: jest.fn(),
}));

const mockLockPrepaymentLine = jest.fn();
const mockListVendorPrepayments = jest.fn();
jest.mock("../prepayments", () => ({
  lockPrepaymentLine: (...args: unknown[]) => mockLockPrepaymentLine(...args),
  listVendorPrepayments: (...args: unknown[]) => mockListVendorPrepayments(...args),
}));

const mockComputeBillBalance = jest.fn();
jest.mock("../../finance/recompute-bill-finance", () => ({
  computeBillBalance: (...args: unknown[]) => mockComputeBillBalance(...args),
}));

import { settleBills } from "../settle";
import { BillSettlementError, type SettleBillsInput } from "../types";
import { VendorCreditError } from "../../vendor-credits/types";

function fakeClient() {
  const calls: string[] = [];
  return {
    calls,
    query: jest.fn(async (sql: string) => {
      calls.push(sql.trim().split("\n")[0]!.trim());
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM vendor_bill WHERE")) return { rows: [{ id: "vb_1", vendor_id: "qbv_1" }] };
      if (sql.includes("FROM gl_check WHERE")) return { rows: [{ doc_number: "1042" }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
}

function deps() {
  return {
    pool: { connect: jest.fn(async () => fakeClient()) },
    knex: {} as never,
    runLedgerHook: jest.fn(async () => undefined),
  };
}

const baseInput: SettleBillsInput = {
  vendor_id: "qbv_1",
  settlement_date: "2026-09-17",
  credit_allocations: [],
  prepayment_allocations: [],
  cash: null,
  actor_id: "u1",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockApplyVendorCreditToBill.mockResolvedValue({ id: "vcap_1", auto_adjustment_ids: [] });
  mockEnqueueVendorCreditApply.mockResolvedValue({ queued: true, pipelineRowId: "op_1" });
  mockEnqueueVendorCreditAdd.mockResolvedValue({ queued: true, pipelineRowId: "op_2" });
  mockEnqueueBillPaymentAdd.mockResolvedValue({ queued: true, pipelineRowId: "op_3" });
  mockCreateBillPayment.mockResolvedValue({ id: "vbp_1", number: "BP-1001", auto_adjustment_ids: [] });
  mockLockPrepaymentLine.mockResolvedValue({
    check_id: "chk_1",
    account_list_id: "80000152-1621454214",
    account_name: "VEETECH Co., Ltd",
    remaining_cents: 100_000,
  });
  mockComputeBillBalance.mockResolvedValue({ balance_cents: 100_000 });
  mockCreateDraftVendorCredit.mockResolvedValue({ id: "vcr_1", number: "VC-2001" });
  mockMarkVendorCreditPosted.mockResolvedValue({ id: "vcr_1", number: "VC-2001" });
});

describe("settleBills", () => {
  it("runs credit -> prepayment -> cash, in order, and lists all 3 steps", async () => {
    const result = await settleBills(deps(), {
      ...baseInput,
      credit_allocations: [{ credit_id: "vcr_0", vendor_bill_id: "vb_1", amount_cents: 1_000 }],
      prepayment_allocations: [{ gl_check_line_id: "gcl_1", vendor_bill_id: "vb_1", amount_cents: 2_000 }],
      cash: {
        bank_account_list_id: "80000005-BANK",
        method: "check",
        allocations: [{ vendor_bill_id: "vb_1", amount_cents: 3_000 }],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.kind)).toEqual(["credit", "prepayment", "cash"]);
    expect(mockApplyVendorCreditToBill).toHaveBeenCalledTimes(2); // step 1 + step 2's own apply
    expect(mockCreateBillPayment).toHaveBeenCalledTimes(1);
  });

  it("cuts at the first failure: a 2nd credit that exceeds the bill balance stops before cash", async () => {
    mockApplyVendorCreditToBill
      .mockResolvedValueOnce({ id: "vcap_1", auto_adjustment_ids: [] })
      .mockRejectedValueOnce(new VendorCreditError("exceeds_bill_balance", "too much", 409));

    const result = await settleBills(deps(), {
      ...baseInput,
      credit_allocations: [
        { credit_id: "vcr_1", vendor_bill_id: "vb_1", amount_cents: 1_000 },
        { credit_id: "vcr_2", vendor_bill_id: "vb_1", amount_cents: 999_999 },
      ],
      cash: {
        bank_account_list_id: "80000005-BANK",
        method: "check",
        allocations: [{ vendor_bill_id: "vb_1", amount_cents: 3_000 }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failed?.code).toBe("exceeds_bill_balance");
    expect(result.steps.length).toBe(1);
    expect(mockCreateBillPayment).not.toHaveBeenCalled();
  });

  it("rejects an invalid settlement_date before touching deps at all", async () => {
    const d = deps();
    await expect(
      settleBills(d, { ...baseInput, settlement_date: "09/17/2026" })
    ).rejects.toThrow(BillSettlementError);
    expect(d.pool.connect).not.toHaveBeenCalled();
    expect(mockApplyVendorCreditToBill).not.toHaveBeenCalled();
  });

  it("prepayment step: createDraftVendorCredit gets prepayment.consumed_cents === amount_cents and one qb_account line against the check's account", async () => {
    await settleBills(deps(), {
      ...baseInput,
      prepayment_allocations: [{ gl_check_line_id: "gcl_1", vendor_bill_id: "vb_1", amount_cents: 2_500 }],
    });

    expect(mockCreateDraftVendorCredit).toHaveBeenCalledTimes(1);
    const input = mockCreateDraftVendorCredit.mock.calls[0]![1] as {
      lines: Array<{ line_type: string; qb_account_list_id: string; amount_cents: number }>;
      prepayment: { gl_check_id: string; gl_check_line_id: string; consumed_cents: number };
    };
    expect(input.prepayment.consumed_cents).toBe(2_500);
    expect(input.prepayment.gl_check_line_id).toBe("gcl_1");
    expect(input.lines).toHaveLength(1);
    expect(input.lines[0]!.line_type).toBe("qb_account");
    expect(input.lines[0]!.qb_account_list_id).toBe("80000152-1621454214");
    expect(input.lines[0]!.amount_cents).toBe(2_500);
  });
});
