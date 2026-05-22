import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../modules/quickbooks-catalog";

// ── Mock the bridge transport + side-effecting deps so the poller runs purely
//    against in-memory fixtures (no network, no QB Desktop). ─────────────────
const pollBridgeStatus = jest.fn();
jest.mock("../../lib/quickbooks/bridge-fetch", () => ({
  pollBridgeStatus: (...args: unknown[]) => pollBridgeStatus(...args),
}));
jest.mock("../../lib/quickbooks/stale-row-cleanup", () => ({
  markStaleRowsAsFailed: jest.fn().mockResolvedValue(undefined),
  STANDARD_STALE_CONFIG: [],
}));
jest.mock("../../workflows/sync-product-meilisearch", () => ({
  syncProductToMeiliSearchWorkflow: () => ({
    run: jest.fn().mockResolvedValue({}),
  }),
}));
jest.mock("../../workflows/update-inventory-incremental", () => ({
  updateInventoryIncrementalWorkflow: () => ({
    run: jest.fn().mockResolvedValue({}),
  }),
}));

import qbItemPipelinePoller from "../../jobs/qb-item-pipeline-poller";

const BRIDGE = "http://bridge.test";

type Row = Record<string, unknown>;

/** Build a container whose query.graph returns `waiting` rows for the Phase A
 * filter and `error` rows for the Phase B filter. Captures catalog + knex calls. */
function buildContainer(opts: { waiting?: Row[]; error?: Row[] }) {
  const updateQbItemPipelines = jest.fn().mockResolvedValue(undefined);
  const knexRaw = jest.fn().mockResolvedValue(undefined);
  const graph = jest.fn(async ({ filters }: { filters?: { status?: string } }) => {
    if (filters?.status === "waiting") return { data: opts.waiting ?? [] };
    if (filters?.status === "error") return { data: opts.error ?? [] };
    return { data: [] };
  });

  const container = {
    resolve: (key: string) => {
      if (key === "logger")
        return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      if (key === ContainerRegistrationKeys.QUERY) return { graph };
      if (key === QUICKBOOKS_CATALOG_MODULE) return { updateQbItemPipelines };
      if (key === "__pg_connection__") return { raw: knexRaw };
      throw new Error(`unexpected resolve(${key})`);
    },
  } as any;

  return { container, updateQbItemPipelines, knexRaw, graph };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.QB_BRIDGE_URL = BRIDGE;
  process.env.QB_API_KEY = "test-key";
});

describe("qb-item-pipeline-poller — name-conflict reconcile", () => {
  it("Phase B: an add that hit 'already in use' queries QB by FullName and tags the row for reconcile", async () => {
    const errorRow: Row = {
      id: "row1",
      variant_id: "var_1",
      sku: "LUX-LR23461",
      op_action: "add",
      qb_id: null,
      op_payload: { Name: "LUX-LR23461", SalesPrice: 10.99, ItemType: "Inventory" },
      retries: 0,
      last_error:
        "QuickBooks Error 3100: The name LUX-LR23461 of the list element is already in use.",
      next_retry_at: null,
    };
    const { container, updateQbItemPipelines } = buildContainer({
      error: [errorRow],
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ operationId: "iq-1" }),
      text: async () => "",
    });
    global.fetch = fetchMock as any;

    await qbItemPipelinePoller(container);

    // Queried QB by FullName for the conflicting SKU.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${BRIDGE}/api/products?FullName=${encodeURIComponent("LUX-LR23461")}`
    );
    expect((init as any)?.method ?? "GET").toBe("GET");

    // Row parked as waiting with the reconcile flag + the new query operationId.
    expect(updateQbItemPipelines).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "row1",
        status: "waiting",
        qb_operation_id: "iq-1",
        op_payload: expect.objectContaining({
          Name: "LUX-LR23461",
          __iq_reconcile: true,
        }),
      })
    );
  });

  it("Phase A: a completed reconcile query links the existing ListID to the variant and resubmits as a mod", async () => {
    const waitingRow: Row = {
      id: "row1",
      variant_id: "var_1",
      sku: "LUX-LR23461",
      qb_operation_id: "iq-1",
      qb_id: null,
      op_action: "add",
      op_payload: {
        Name: "LUX-LR23461",
        SalesDesc: "LED ceiling light",
        SalesPrice: 10.99,
        PurchaseCost: 4.55,
        ItemType: "Inventory",
        __iq_reconcile: true,
      },
      item_type: "Inventory",
      retries: 0,
    };
    const { container, updateQbItemPipelines, knexRaw } = buildContainer({
      waiting: [waitingRow],
    });

    // The reconcile ItemQuery completed and returned the existing item's ids.
    pollBridgeStatus.mockResolvedValue({
      status: "completed",
      data: {
        operation: {
          status: "completed",
          listId: "80000123-1700000000",
          editSequence: "5",
        },
      },
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ operationId: "mod-1" }),
      text: async () => "",
    });
    global.fetch = fetchMock as any;

    await qbItemPipelinePoller(container);

    // Linked the recovered ListID + EditSequence onto the variant.
    expect(knexRaw).toHaveBeenCalledTimes(1);
    const [sql, params] = knexRaw.mock.calls[0];
    expect(sql).toContain("quickbooks_id");
    expect(params).toEqual(["80000123-1700000000", "5", "var_1"]);

    // Resubmitted as a mod (PUT to /api/products/:listId).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BRIDGE}/api/products/80000123-1700000000`);
    expect((init as any).method).toBe("PUT");
    const sentBody = JSON.parse((init as any).body);
    expect(sentBody.action).toBe("mod");
    expect(sentBody.data).toEqual(
      expect.objectContaining({
        ListID: "80000123-1700000000",
        EditSequence: "5",
        Name: "LUX-LR23461",
      })
    );

    // Row flipped to a waiting mod with the recovered identity.
    expect(updateQbItemPipelines).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "row1",
        status: "waiting",
        op_action: "mod",
        qb_id: "80000123-1700000000",
        qb_operation_id: "mod-1",
      })
    );
  });

  it("Phase A: a reconcile query that finds no item falls back to retrying the add (no reconcile flag)", async () => {
    const waitingRow: Row = {
      id: "row1",
      variant_id: "var_1",
      sku: "LUX-LR23461",
      qb_operation_id: "iq-1",
      qb_id: null,
      op_action: "add",
      op_payload: { Name: "LUX-LR23461", __iq_reconcile: true },
      retries: 0,
    };
    const { container, updateQbItemPipelines, knexRaw } = buildContainer({
      waiting: [waitingRow],
    });

    // Completed but empty — QB returned no matching item (no listId).
    pollBridgeStatus.mockResolvedValue({
      status: "completed",
      data: { operation: { status: "completed" } },
    });
    global.fetch = jest.fn() as any;

    await qbItemPipelinePoller(container);

    // No link written, no resubmit attempted.
    expect(knexRaw).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();

    // Restored to error WITHOUT the reconcile flag so Phase B retries the add.
    expect(updateQbItemPipelines).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "row1",
        status: "error",
        qb_operation_id: null,
        op_payload: expect.not.objectContaining({ __iq_reconcile: true }),
      })
    );
  });
});
