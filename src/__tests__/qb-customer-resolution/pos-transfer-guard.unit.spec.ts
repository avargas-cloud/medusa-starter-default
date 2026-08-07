/**
 * Unit tests for POST /admin/pos-transfer — customer-change chokepoint.
 *
 * Business rules (2026-08-06):
 *  · ≥1 non-voided POS invoice → 409 INVOICES_EXIST (void first).
 *  · Linked deposits/payments → 409 PAYMENTS_LINKED until the operator picks
 *    payment_action = transfer | unlink (supervisor PIN, verified here).
 *    A payment with any active invoice-bound application cannot transfer;
 *    web-source payments can do neither (permanent Treasury ledger).
 *  · The qb_list_id cache is re-stamped from the NEW customer — or CLEARED
 *    (null) when the new customer has no ListID yet — with provenance.
 *  · Documents already in QB get their MOD handlers fired (cases 1-4).
 *
 * Type: mock-based unit test (no DB, no Medusa services, PIN guard mocked).
 */

jest.mock(
  "../../lib/quickbooks/handlers/handle-draft-order-updated",
  () => ({ handleDraftOrderUpdated: jest.fn().mockResolvedValue("scheduled") })
);
jest.mock("../../lib/quickbooks/handlers/handle-order-updated", () => ({
  handleOrderUpdated: jest.fn().mockResolvedValue("scheduled"),
}));
jest.mock("../../api/utils/db-pool", () => ({
  getDbPool: jest.fn(),
}));
jest.mock("../../lib/pos/supervisor-pin-guard", () => ({
  extractSupervisorPin: jest.fn().mockReturnValue("0000"),
  guardSupervisorPin: jest.fn().mockResolvedValue({ ok: true }),
  pinGuardResponse: jest.fn().mockReturnValue({
    status: 401,
    body: { error: "PIN required" },
  }),
  resolveActorId: jest.fn().mockReturnValue("user_1"),
}));
jest.mock("../../lib/pos/verify-supervisor-pin", () => ({
  pgAsPinConn: jest.fn((x: unknown) => x),
}));
jest.mock("../../api/admin/finance/_lib/refresh-order-docs", () => ({
  refreshOrderDocsForPayment: jest.fn().mockResolvedValue(undefined),
}));

import { handleDraftOrderUpdated } from "../../lib/quickbooks/handlers/handle-draft-order-updated";
import { handleOrderUpdated } from "../../lib/quickbooks/handlers/handle-order-updated";
import { guardSupervisorPin } from "../../lib/pos/supervisor-pin-guard";
import { getDbPool } from "../../api/utils/db-pool";
import { POST } from "../../api/admin/pos-transfer/route";

const mockEstimateMod = handleDraftOrderUpdated as jest.MockedFunction<
  typeof handleDraftOrderUpdated
>;
const mockSoMod = handleOrderUpdated as jest.MockedFunction<
  typeof handleOrderUpdated
>;
const mockGetDbPool = getDbPool as jest.MockedFunction<typeof getDbPool>;
const mockPinGuard = guardSupervisorPin as jest.MockedFunction<
  typeof guardSupervisorPin
>;

// ─── Pool mock ───────────────────────────────────────────────────────────────

interface LinkedPaymentFixture {
  id: string;
  amount: number;
  status?: string;
  customer_id?: string;
  source?: string | null;
  locked_order_id?: string | null;
  qb_txn?: string | null;
  has_invoice_apps?: boolean;
}

function installPool(opts: {
  linkedPayments?: LinkedPaymentFixture[];
  liveListId?: string | null;
  invoiceAppsInsideLock?: number;
}) {
  const routed = jest.fn(async (sql: string) => {
    if (/FROM customer_payment cp/i.test(sql)) {
      return {
        rows: (opts.linkedPayments ?? []).map((p) => ({
          id: p.id,
          amount: p.amount,
          status: p.status ?? "available",
          customer_id: p.customer_id ?? "cus_OLD",
          source: p.source ?? "pos",
          locked_order_id: p.locked_order_id ?? null,
          qb_txn: p.qb_txn ?? null,
          has_invoice_apps: p.has_invoice_apps ?? false,
        })),
      };
    }
    if (/FROM customer WHERE/i.test(sql))
      return { rows: [{ live: opts.liveListId ?? null }] };
    if (/FROM customer_payment\s+WHERE id = \$1 FOR UPDATE/i.test(sql)) {
      const p = (opts.linkedPayments ?? [])[0];
      return {
        rows: p
          ? [
              {
                id: p.id,
                customer_id: p.customer_id ?? "cus_OLD",
                amount: p.amount,
                metadata: p.qb_txn ? { qb_txn_id: p.qb_txn } : {},
              },
            ]
          : [],
      };
    }
    if (/COUNT\(\*\)::int AS n FROM payment_application/i.test(sql))
      return { rows: [{ n: opts.invoiceAppsInsideLock ?? 0 }] };
    if (/FROM qb_order_pipeline/i.test(sql)) return { rows: [] };
    if (/SUM\(amount_applied\)/i.test(sql)) return { rows: [{ applied: 0 }] };
    return { rows: [], rowCount: 1 };
  });
  const client = {
    query: routed,
    release: jest.fn(),
  };
  const pool = {
    query: routed,
    connect: jest.fn().mockResolvedValue(client),
  };
  mockGetDbPool.mockReturnValue(pool as unknown as ReturnType<typeof getDbPool>);
  return { query: routed, client, pool };
}

function sqlCalls(query: jest.Mock, re: RegExp) {
  return query.mock.calls.filter(([sql]) => re.test(sql as string));
}

// ─── Request/response builders ───────────────────────────────────────────────

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
    auth_context: { actor_id: "user_1" },
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

const OLD_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  mockPinGuard.mockResolvedValue({ ok: true } as never);
  process.env = { ...OLD_ENV };
  delete process.env.QB_ORDER_FLOW_ENABLED;
});

afterAll(() => {
  process.env = OLD_ENV;
});

// ─── Invoice guard ───────────────────────────────────────────────────────────

describe("pos-transfer — invoice guard", () => {
  it("returns 400 when id or customer_id is missing", async () => {
    installPool({});
    const res = buildRes();
    await POST(buildReq({ body: { id: "order_1" } }), res);
    expect(res._status).toHaveBeenCalledWith(400);
  });

  it("blocks with 409 INVOICES_EXIST and the invoice numbers", async () => {
    installPool({});
    const req = buildReq({
      invoices: [{ invoice_number: "20188", status: "paid", voided_at: null }],
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(409);
    const body = statusJson(res);
    expect(body.code).toBe("INVOICES_EXIST");
    expect(body.invoices).toEqual([{ number: "20188", status: "paid" }]);
    expect(req._orderModule.updateOrders).not.toHaveBeenCalled();
  });

  it("does NOT count voided invoices", async () => {
    installPool({ liveListId: "LIST-B" });
    const req = buildReq({
      invoices: [
        { invoice_number: "20188", status: "voided", voided_at: null },
        { invoice_number: "20189", status: "paid", voided_at: "2026-08-01" },
      ],
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(200);
    expect(req._orderModule.updateOrders).toHaveBeenCalled();
  });

  it("skips every guard when the customer is not changing", async () => {
    const { query } = installPool({});
    const req = buildReq({
      currentCustomerId: "cus_NEW",
      invoices: [{ invoice_number: "20188", status: "paid", voided_at: null }],
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(200);
    expect(req._invoiceService.listPosInvoices).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

// ─── Cache re-stamp ──────────────────────────────────────────────────────────

describe("pos-transfer — qb_list_id re-stamp", () => {
  it("stamps the NEW customer's live ListID with provenance", async () => {
    const { query } = installPool({ liveListId: "LIST-B" });
    const res = buildRes();
    await POST(buildReq({}), res);

    const stamps = sqlCalls(query, /^\s*UPDATE "order"/i);
    expect(stamps).toHaveLength(1);
    expect(stamps[0][1]).toEqual(["LIST-B", "cus_NEW", "order_1"]);
  });

  it("CLEARS the cache (null) when the new customer has no ListID yet — never leaves the previous owner's", async () => {
    const { query } = installPool({ liveListId: null });
    const res = buildRes();
    await POST(buildReq({}), res);

    expect(res._status).toHaveBeenCalledWith(200);
    const stamps = sqlCalls(query, /^\s*UPDATE "order"/i);
    expect(stamps).toHaveLength(1);
    expect(stamps[0][1]).toEqual([null, "cus_NEW", "order_1"]);
  });
});

// ─── Linked payments ─────────────────────────────────────────────────────────

describe("pos-transfer — linked payments", () => {
  it("returns 409 PAYMENTS_LINKED with per-payment flags when no payment_action was given", async () => {
    installPool({
      linkedPayments: [
        { id: "cpay_1", amount: 50000 },
        { id: "cpay_2", amount: 10000, has_invoice_apps: true },
      ],
    });
    const req = buildReq({});
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(409);
    const body = statusJson(res);
    expect(body.code).toBe("PAYMENTS_LINKED");
    expect(body.payments).toEqual([
      {
        id: "cpay_1",
        amount_cents: 50000,
        transferable: true,
        applied_elsewhere: false,
        web_locked: false,
      },
      {
        id: "cpay_2",
        amount_cents: 10000,
        transferable: false,
        applied_elsewhere: true,
        web_locked: false,
      },
    ]);
    expect(req._orderModule.updateOrders).not.toHaveBeenCalled();
  });

  it("payment_action=transfer moves the payment and enqueues the QB transfer_payment row", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "true";
    const { query } = installPool({
      linkedPayments: [{ id: "cpay_1", amount: 50000, qb_txn: "PAY-TXN-1" }],
      liveListId: "LIST-B",
    });
    const req = buildReq({
      body: { id: "order_1", customer_id: "cus_NEW", payment_action: "transfer" },
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(200);
    expect(req._orderModule.updateOrders).toHaveBeenCalled();
    expect(
      sqlCalls(query, /UPDATE customer_payment SET customer_id/i)
    ).toHaveLength(1);
    expect(
      sqlCalls(query, /INSERT INTO customer_payment_transfer/i)
    ).toHaveLength(1);
    const pipeline = sqlCalls(query, /INSERT INTO qb_order_pipeline/i);
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0][1]?.[0]).toBe("cpay_1");
  });

  it("payment_action=transfer is refused with PAYMENT_APPLIED when the payment touched an invoice", async () => {
    installPool({
      linkedPayments: [
        { id: "cpay_1", amount: 50000, has_invoice_apps: true },
      ],
    });
    const req = buildReq({
      body: { id: "order_1", customer_id: "cus_NEW", payment_action: "transfer" },
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(409);
    expect(statusJson(res).code).toBe("PAYMENT_APPLIED");
    expect(req._orderModule.updateOrders).not.toHaveBeenCalled();
  });

  it("payment_action=unlink detaches the payment and keeps it with the old customer", async () => {
    const { query } = installPool({
      linkedPayments: [{ id: "cpay_1", amount: 50000 }],
      liveListId: "LIST-B",
    });
    const req = buildReq({
      body: { id: "order_1", customer_id: "cus_NEW", payment_action: "unlink" },
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(200);
    expect(sqlCalls(query, /DELETE FROM payment_application/i)).toHaveLength(1);
    expect(
      sqlCalls(query, /SET locked_order_id = NULL/i)
    ).toHaveLength(1);
    // The payment's CUSTOMER is untouched on unlink.
    expect(
      sqlCalls(query, /UPDATE customer_payment SET customer_id/i)
    ).toHaveLength(0);
  });

  it("web-source payments allow neither action (permanent Treasury ledger)", async () => {
    installPool({
      linkedPayments: [{ id: "cpay_1", amount: 50000, source: "web" }],
    });
    const req = buildReq({
      body: { id: "order_1", customer_id: "cus_NEW", payment_action: "unlink" },
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(409);
    expect(statusJson(res).code).toBe("PAYMENTS_WEB_LOCKED");
    expect(req._orderModule.updateOrders).not.toHaveBeenCalled();
  });

  it("both payment actions demand the supervisor PIN (verified in the route)", async () => {
    installPool({ linkedPayments: [{ id: "cpay_1", amount: 50000 }] });
    mockPinGuard.mockResolvedValue({ ok: false, reason: "invalid" } as never);
    const req = buildReq({
      body: { id: "order_1", customer_id: "cus_NEW", payment_action: "transfer" },
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(401);
    expect(req._orderModule.updateOrders).not.toHaveBeenCalled();
  });
});

// ─── Propagation to existing QB documents ────────────────────────────────────

describe("pos-transfer — propagation to existing QB documents", () => {
  it("case 3: fires customer MODs for BOTH the QB Estimate and the QB Sales Order", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "true";
    installPool({ liveListId: "LIST-B" });
    const req = buildReq({
      metadata: {
        qb_estimate: { txn_id: "EST-TXN-1" },
        qb_sales_order: { txn_id: "SO-TXN-1" },
      },
    });
    const res = buildRes();
    await POST(req, res);

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
    installPool({ liveListId: "LIST-B" });
    const res = buildRes();
    await POST(
      buildReq({ metadata: { qb_estimate: { txn_id: "EST-TXN-1" } } }),
      res
    );
    expect(mockEstimateMod).toHaveBeenCalled();
    expect(mockSoMod).not.toHaveBeenCalled();
  });

  it("case 2: only the Sales Order MOD fires when only a QB SO exists", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "true";
    installPool({ liveListId: "LIST-B" });
    const res = buildRes();
    await POST(
      buildReq({ metadata: { qb_sales_order: { txn_id: "SO-TXN-1" } } }),
      res
    );
    expect(mockEstimateMod).not.toHaveBeenCalled();
    expect(mockSoMod).toHaveBeenCalled();
  });

  it("case 4: nothing is enqueued when no document exists in QB yet", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "true";
    installPool({ liveListId: "LIST-B" });
    const res = buildRes();
    await POST(buildReq({ metadata: {} }), res);
    expect(mockEstimateMod).not.toHaveBeenCalled();
    expect(mockSoMod).not.toHaveBeenCalled();
  });

  it("does not propagate when the invoice guard blocked the change", async () => {
    process.env.QB_ORDER_FLOW_ENABLED = "true";
    installPool({});
    const req = buildReq({
      invoices: [{ invoice_number: "20188", status: "paid", voided_at: null }],
      metadata: { qb_sales_order: { txn_id: "SO-TXN-1" } },
    });
    const res = buildRes();
    await POST(req, res);

    expect(res._status).toHaveBeenCalledWith(409);
    expect(mockSoMod).not.toHaveBeenCalled();
  });
});
