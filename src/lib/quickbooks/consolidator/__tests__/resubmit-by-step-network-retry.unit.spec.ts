/**
 * Unit coverage for the outer catch block of `resubmitByStep` (2026-09-11):
 * a network failure (dead tunnel, undici connect timeout) on
 * `vendor_bill_payment_check` now retries with backoff instead of dying
 * terminal — see the comment above the `if` in resubmit-by-step.ts's catch.
 * Mirrors the jest.mock pattern of resubmit-by-step-gl-purchases.unit.spec.ts
 * (that spec is green and exercises the same imports).
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

const mockDeferPipelineRow = jest.fn();
const mockFailPipelineRow = jest.fn();
const mockFailOrRetryPipelineRow = jest.fn();
jest.mock("../../pipeline/row-mutations", () => ({
  deferPipelineRow: (...args: unknown[]) => mockDeferPipelineRow(...args),
  failPipelineRow: (...args: unknown[]) => mockFailPipelineRow(...args),
  failOrRetryPipelineRow: (...args: unknown[]) =>
    mockFailOrRetryPipelineRow(...args),
}));

// Case B's control step ("customer") is the one call site in the switch,
// besides vendor_bill_mod/vendor_bill_payment_check, whose case has NO inner
// try/catch of its own — every other bridgeFetch case (vendor_bill_void,
// vendor_credit_add/void, bill_payment_add/void) swallows its own error and
// calls fail*PipelineRow itself, so it never reaches the outer catch under
// test. Mocking this module is the minimal way to make "customer" throw.
const mockProcessCustomerPipelineRow = jest.fn();
jest.mock("../customer-pass", () => ({
  processCustomerPipelineRow: (...args: unknown[]) =>
    mockProcessCustomerPipelineRow(...args),
  processCustomerDataExtPipelineRow: jest.fn(),
}));

import {
  resubmitByStep,
  describeDispatchError,
  type ResubmitRow,
} from "../resubmit-by-step";

const fakeContainer = {
  resolve: () => ({}),
} as unknown as MedusaContainer;
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function networkError(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("resubmitByStep — catch routing on network failure", () => {
  it("Case A: vendor_bill_payment_check retries with backoff (failOrRetryPipelineRow), never terminal", async () => {
    mockBridgeFetch.mockRejectedValue(networkError());
    const row: ResubmitRow = {
      id: "row-check",
      order_id: null,
      reference_id: "vb_x",
      reference_type: "vendor_bill",
      step: "vendor_bill_payment_check",
      qb_txn_id: "1CA387-1",
      retry_count: 0,
      payload: { txn_id: "1CA387-1" },
    };

    await resubmitByStep(row, fakeContainer, logger);

    expect(mockFailOrRetryPipelineRow).toHaveBeenCalledTimes(1);
    expect(mockFailOrRetryPipelineRow).toHaveBeenCalledWith(
      "row-check",
      "fetch failed (UND_ERR_CONNECT_TIMEOUT)",
      0
    );
    expect(mockFailPipelineRow).not.toHaveBeenCalled();
  });

  it("Case B (control): the 'customer' step routes the same network failure to failPipelineRow (terminal), not failOrRetryPipelineRow", async () => {
    mockProcessCustomerPipelineRow.mockRejectedValue(networkError());
    const row: ResubmitRow = {
      id: "row-customer",
      order_id: null,
      reference_id: "cust_1",
      reference_type: "customer",
      step: "customer",
      qb_txn_id: null,
      retry_count: 0,
      payload: null,
    };

    await resubmitByStep(row, fakeContainer, logger);

    expect(mockFailPipelineRow).toHaveBeenCalledTimes(1);
    expect(mockFailPipelineRow).toHaveBeenCalledWith(
      "row-customer",
      "fetch failed (UND_ERR_CONNECT_TIMEOUT)"
    );
    expect(mockFailOrRetryPipelineRow).not.toHaveBeenCalled();
  });
});

describe("describeDispatchError", () => {
  it("appends err.cause.code in parentheses when present", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    expect(describeDispatchError(err)).toBe("fetch failed (ECONNREFUSED)");
  });

  it("returns the plain message when there is no cause", () => {
    const err = new Error("plain failure");
    expect(describeDispatchError(err)).toBe("plain failure");
  });

  it("leaves the message unchanged when it already contains the code", () => {
    const err = Object.assign(new Error("fetch failed (ECONNREFUSED)"), {
      cause: { code: "ECONNREFUSED" },
    });
    expect(describeDispatchError(err)).toBe("fetch failed (ECONNREFUSED)");
  });

  it("stringifies a non-Error thrown value", () => {
    expect(describeDispatchError("boom")).toBe("boom");
  });
});
