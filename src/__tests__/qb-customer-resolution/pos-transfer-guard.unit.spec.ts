/**
 * Unit tests for POST /admin/pos-transfer — the invoice guard.
 *
 * Business rule (2026-08-06): a customer change on a pos-order is only legal
 * while the order has ZERO non-voided POS invoices. One invoice — partial or
 * total, destined to become a QB Invoice or a QB Sales Receipt — blocks the
 * change with 409 INVOICES_EXIST and the invoice numbers, so the operator can
 * void first. The route is the authority; the POS modal only displays this.
 *
 * Type: mock-based unit test (no DB, no Medusa services).
 */

jest.mock(
  "../../lib/quickbooks/handlers/handle-draft-order-updated",
  () => ({ handleDraftOrderUpdated: jest.fn().mockResolvedValue("scheduled") })
);
jest.mock("../../lib/quickbooks/handlers/handle-order-updated", () => ({
  handleOrderUpdated: jest.fn().mockResolvedValue("scheduled"),
}));
jest.mock("../../lib/quickbooks/resolve-order-qb-customer", () => ({
  resolveOrderQbCustomer: jest.fn().mockResolvedValue("LIST-LIVE"),
}));

import { handleDraftOrderUpdated } from "../../lib/quickbooks/handlers/handle-draft-order-updated";
import { handleOrderUpdated } from "../../lib/quickbooks/handlers/handle-order-updated";
import { resolveOrderQbCustomer } from "../../lib/quickbooks/resolve-order-qb-customer";
import { POST } from "../../api/admin/pos-transfer/route";

const mockResolve = resolveOrderQbCustomer as jest.MockedFunction<
  typeof resolveOrderQbCustomer
>;

const mockEstimateMod = handleDraftOrderUpdated as jest.MockedFunction<
  typeof handleDraftOrderUpdated
>;
const mockSoMod = handleOrderUpdated as jest.MockedFunction<
  typeof handleOrderUpdated
>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface FakeInvoice {
  invoice_number: string;
  status: string;
  voided_at: string | null;
}

function buildReq(opts: {
  body?: Record<string, unknown>;
  currentCustomerId?: string;
  invoices?: FakeInvoice[];
  metadata?: Record<string, unknown>;
}) {
  const orderModule = {
    retrieveOrder: jest.fn().mockResolvedValue({
      id: "order_1",
      customer_id: opts.currentCustomerId ?? "cus_OLD",
      metadata: opts.metadata ?? {},
    }),
    updateOrders: jest
      .fn()
      .mockResolvedValue([{ id: "order_1", customer_id: "cus_NEW" }]),
  };
  const invoiceService = {
    listPosInvoices: jest.fn().mockResolvedValue(opts.invoices ?? []),
  };

  return {
    body: opts.body ?? { id: "order_1", customer_id: "cus_NEW" },
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "order") return orderModule;
        if (key === "invoices") return invoiceService;
        if (key === "logger")
          return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        return null;
      }),
    },
    _orderModule: orderModule,
    _invoiceService: invoiceService,
  } as unknown as Parameters<typeof POST>[0] & {
    _orderModule: typeof orderModule;
    _invoiceService: typeof invoiceService;
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
  } as unknown as Parameters<typeof POST>[1] & {
    _status: jest.Mock;
    _json: jest.Mock;
  };
}

function statusJson(res: { _status: jest.Mock }): Record<string, unknown> {
  const ret = res._status.mock.results[res._status.mock.results.length - 1]
    ?.value as { json: jest.Mock };
  return ret.json.mock.calls[ret.json.mock.calls.length - 1]?.[0] ?? {};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const OLD_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD_ENV };
  delete process.env.QB_ORDER_FLOW_ENABLED;
});

afterAll(() => {
  process.env = OLD_ENV;
});

describe("POST /admin/pos-transfer — invoice guard", () => {
  it("returns 400 when id or customer_id is missing", async () => {
    const res = buildRes();
    await POST(buildReq({ body: { id: "order_1" } }), res);
    expect(res._status).toHaveBeenCalledWith(400);
  });

  it("blocks the customer change with 409 INVOICES_EXIST when a non-voided invoice exists", async () => {
    const req = buildReq({
      invoices: [
        { invoice_number: "20188", status: "paid", voided_at: null },
      ],
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(409);
    const body = statusJson(res);
    expect(body.code).toBe("INVOICES_EXIST");
    expect(body.invoices).toEqual([{ number: "20188", status: "paid" }]);
    expect(req._orderModule.updateOrders).not.toHaveBeenCalled();
  });

  it("blocks with every active invoice number when several exist", async () => {
    const req = buildReq({
      invoices: [
        { invoice_number: "21001", status: "issued", voided_at: null },
        { invoice_number: "21002", status: "paid", voided_at: null },
      ],
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(409);
    expect(statusJson(res).invoices).toEqual([
      { number: "21001", status: "issued" },
      { number: "21002", status: "paid" },
    ]);
  });

  it("does NOT count voided invoices — a fully voided order can change customer", async () => {
    const req = buildReq({
      invoices: [
        { invoice_number: "20188", status: "voided", voided_at: null },
        {
          invoice_number: "20189",
          status: "paid",
          voided_at: "2026-08-01T00:00:00Z",
        },
      ],
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(200);
    expect(req._orderModule.updateOrders).toHaveBeenCalledWith([
      expect.objectContaining({ id: "order_1", customer_id: "cus_NEW" }),
    ]);
  });

  it("skips the guard entirely when the customer is not actually changing", async () => {
    const req = buildReq({
      currentCustomerId: "cus_NEW", // same as the one in the body
      invoices: [
        { invoice_number: "20188", status: "paid", voided_at: null },
      ],
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(200);
    expect(req._invoiceService.listPosInvoices).not.toHaveBeenCalled();
    expect(req._orderModule.updateOrders).toHaveBeenCalled();
  });

  it("transfers normally when the order has no invoices at all", async () => {
    const req = buildReq({ invoices: [] });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(200);
    expect(req._orderModule.updateOrders).toHaveBeenCalledWith([
      expect.objectContaining({ customer_id: "cus_NEW" }),
    ]);
  });

  it("re-stamps order.metadata.qb_list_id from the new customer after the transfer", async () => {
    const req = buildReq({ invoices: [] });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(200);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order_1" })
    );
  });

  it("does not re-stamp when the customer is unchanged", async () => {
    const req = buildReq({ currentCustomerId: "cus_NEW" });
    const res = buildRes();
    await POST(req, res);

    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe("POST /admin/pos-transfer — propagation to existing QB documents", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("case 3: enqueues a customer MOD for BOTH the QB Estimate and the QB Sales Order", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "true";
    const req = buildReq({
      metadata: {
        qb_estimate: { txn_id: "EST-TXN-1" },
        qb_sales_order: { txn_id: "SO-TXN-1" },
      },
    });
    const res = buildRes();
    await POST(req, res);
    await flush();

    expect(res._status).toHaveBeenCalledWith(200);
    expect(mockEstimateMod).toHaveBeenCalledWith(
      "order_1",
      req.scope,
      expect.anything()
    );
    expect(mockSoMod).toHaveBeenCalledWith(
      "order_1",
      req.scope,
      expect.anything()
    );
  });

  it("case 1: only the Estimate MOD fires when only a QB Estimate exists", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "true";
    const req = buildReq({
      metadata: { qb_estimate: { txn_id: "EST-TXN-1" } },
    });
    const res = buildRes();
    await POST(req, res);
    await flush();

    expect(mockEstimateMod).toHaveBeenCalled();
    expect(mockSoMod).not.toHaveBeenCalled();
  });

  it("case 2: only the Sales Order MOD fires when only a QB SO exists", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "true";
    const req = buildReq({
      metadata: { qb_sales_order: { txn_id: "SO-TXN-1" } },
    });
    const res = buildRes();
    await POST(req, res);
    await flush();

    expect(mockEstimateMod).not.toHaveBeenCalled();
    expect(mockSoMod).toHaveBeenCalled();
  });

  it("case 4: nothing is enqueued when no document exists in QB yet (dispatch builds fresh)", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "true";
    const req = buildReq({ metadata: {} });
    const res = buildRes();
    await POST(req, res);
    await flush();

    expect(mockEstimateMod).not.toHaveBeenCalled();
    expect(mockSoMod).not.toHaveBeenCalled();
  });

  it("does not propagate when the customer did not change", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "true";
    const req = buildReq({
      currentCustomerId: "cus_NEW",
      metadata: { qb_estimate: { txn_id: "EST-TXN-1" } },
    });
    const res = buildRes();
    await POST(req, res);
    await flush();

    expect(mockEstimateMod).not.toHaveBeenCalled();
    expect(mockSoMod).not.toHaveBeenCalled();
  });

  it("does not propagate when the invoice guard blocked the change", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "true";
    const req = buildReq({
      invoices: [{ invoice_number: "20188", status: "paid", voided_at: null }],
      metadata: { qb_sales_order: { txn_id: "SO-TXN-1" } },
    });
    const res = buildRes();
    await POST(req, res);
    await flush();

    expect(res._status).toHaveBeenCalledWith(409);
    expect(mockSoMod).not.toHaveBeenCalled();
  });
});
