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
jest.mock("../../workflows/sync-inventory-item-meilisearch", () => ({
  syncInventoryItemToMeiliSearchWorkflow: () => ({
    run: jest.fn().mockResolvedValue({}),
  }),
}));

import qbItemPipelinePoller from "../../jobs/qb-item-pipeline-poller";

const BRIDGE = "http://bridge.test";

type Row = Record<string, unknown>;

/** Build a container whose query.graph returns `waiting` rows for the Phase A
 * filter and `error` rows for the Phase B filter. Captures catalog + knex calls.
 * knex.raw returns `{ rows: [{ n: 0 }] }` for the stuck-count query. */
function buildContainer(opts: { waiting?: Row[]; error?: Row[] }) {
  const updateQbItemPipelines = jest.fn().mockResolvedValue(undefined);
  const knexRaw = jest.fn().mockResolvedValue({ rows: [{ n: 0 }] });
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

/** The last updateQbItemPipelines call for a given row id (ignores the stuck
 * placeholder/no-payload calls). */
function lastUpdateFor(
  mock: jest.Mock,
  id: string
): Record<string, unknown> | undefined {
  const calls = mock.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((a) => a?.id === id);
  return calls[calls.length - 1];
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.QB_BRIDGE_URL = BRIDGE;
  process.env.QB_API_KEY = "test-key";
});

describe("qb-item-pipeline-poller — name-conflict reconcile", () => {
  it("Phase B: an add that hit 'already in use' queries QB by FullName and sets recovery_mode=reconcile_query", async () => {
    const errorRow: Row = {
      id: "row1",
      variant_id: "var_1",
      sku: "LUX-LR23461",
      op_action: "add",
      qb_id: null,
      op_payload: { Name: "LUX-LR23461", SalesPrice: 10.99, ItemType: "Inventory" },
      retries: 0,
      submit_count: 0,
      recovery_mode: "none",
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

    // Row parked as waiting with the SCALAR reconcile flag + the new query op id.
    expect(updateQbItemPipelines).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "row1",
        status: "waiting",
        qb_operation_id: "iq-1",
        recovery_mode: "reconcile_query",
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
      },
      item_type: "Inventory",
      retries: 0,
      submit_count: 1,
      recovery_mode: "reconcile_query",
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

    // Linked the recovered ListID + EditSequence onto the variant (the stuck-count
    // query also uses knex.raw, so filter to the variant-link call).
    const linkCall = knexRaw.mock.calls.find((c) =>
      String(c[0]).includes("quickbooks_id")
    );
    expect(linkCall).toBeDefined();
    expect(linkCall![1]).toEqual(["80000123-1700000000", "5", "var_1"]);

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

    // Row flipped to a waiting mod with the recovered identity, recovery cleared,
    // and submit_count incremented.
    expect(updateQbItemPipelines).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "row1",
        status: "waiting",
        op_action: "mod",
        qb_id: "80000123-1700000000",
        qb_operation_id: "mod-1",
        recovery_mode: "none",
        submit_count: 2,
      })
    );
  });

  it("Phase A: a reconcile query that finds no item falls back to retrying the add (recovery cleared)", async () => {
    const waitingRow: Row = {
      id: "row1",
      variant_id: "var_1",
      sku: "LUX-LR23461",
      qb_operation_id: "iq-1",
      qb_id: null,
      op_action: "add",
      op_payload: { Name: "LUX-LR23461" },
      retries: 0,
      submit_count: 1,
      recovery_mode: "reconcile_query",
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

    // No variant link written, no resubmit attempted (only the stuck-count query).
    expect(
      knexRaw.mock.calls.some((c) => String(c[0]).includes("quickbooks_id"))
    ).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();

    // Restored to error WITH recovery_mode cleared so Phase B retries the add.
    expect(updateQbItemPipelines).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "row1",
        status: "error",
        qb_operation_id: null,
        recovery_mode: "none",
      })
    );
  });
});

describe("qb-item-pipeline-poller — loop guards & price guardrail", () => {
  it("Phase A: a completed recovery op on a row over the submit cap is demoted to failed_permanent (no resubmit)", async () => {
    const waitingRow: Row = {
      id: "row1",
      variant_id: "var_1",
      sku: "LUX-LR24950",
      qb_operation_id: "mod-99",
      qb_id: "8000188F-1670254873",
      op_action: "mod",
      op_payload: { Name: "LUX-LR24950", ListID: "8000188F-1670254873" },
      item_type: "Inventory",
      retries: 0,
      submit_count: 8, // == MAX_SUBMITS
      recovery_mode: "reconcile_query",
    };
    const { container, updateQbItemPipelines } = buildContainer({
      waiting: [waitingRow],
    });
    pollBridgeStatus.mockResolvedValue({
      status: "completed",
      data: { operation: { status: "completed", listId: "8000188F-1670254873", editSequence: "9" } },
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    await qbItemPipelinePoller(container);

    // Did NOT resubmit — the loop is cut.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateQbItemPipelines).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "row1",
        status: "failed_permanent",
        recovery_mode: "none",
      })
    );
  });

  it("Phase B: an error row over the submit cap is demoted to failed_permanent before any dispatch", async () => {
    const errorRow: Row = {
      id: "row1",
      variant_id: "var_1",
      sku: "LUX-LR24950",
      op_action: "mod",
      qb_id: "8000188F-1670254873",
      op_payload: { Name: "LUX-LR24950", ListID: "8000188F-1670254873" },
      retries: 0,
      submit_count: 12,
      recovery_mode: "none",
      last_error: "some transient error",
      next_retry_at: null,
    };
    const { container, updateQbItemPipelines } = buildContainer({
      error: [errorRow],
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    await qbItemPipelinePoller(container);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastUpdateFor(updateQbItemPipelines, "row1")).toEqual(
      expect.objectContaining({ id: "row1", status: "failed_permanent" })
    );
  });

  it("Phase A (recovery): a reconcile add→mod conversion drops a fabricated SalesPrice/PurchaseCost of 0", async () => {
    // An add with no price defaults to 0. When it converts to a mod via reconcile,
    // that fabricated 0 must NOT overwrite QB's real price (the seq-120 vector).
    const waitingRow: Row = {
      id: "row1",
      variant_id: "var_1",
      sku: "LUX-LR24950",
      qb_operation_id: "iq-9",
      qb_id: null,
      op_action: "add",
      op_payload: {
        Name: "LUX-LR24950",
        SalesPrice: 0,
        PurchaseCost: 0,
        ItemType: "Inventory",
      },
      item_type: "Inventory",
      retries: 0,
      submit_count: 1,
      recovery_mode: "reconcile_query",
    };
    const { container, updateQbItemPipelines } = buildContainer({
      waiting: [waitingRow],
    });
    pollBridgeStatus.mockResolvedValue({
      status: "completed",
      data: { operation: { status: "completed", listId: "8000188F-1670254873", editSequence: "7" } },
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ operationId: "mod-2" }),
      text: async () => "",
    });
    global.fetch = fetchMock as any;

    await qbItemPipelinePoller(container);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(sentBody.action).toBe("mod");
    // Fabricated zero price/cost must NOT be sent (would overwrite QB's real value).
    expect(sentBody.data).not.toHaveProperty("SalesPrice");
    expect(sentBody.data).not.toHaveProperty("PurchaseCost");
    expect(sentBody.data).toEqual(
      expect.objectContaining({ ListID: "8000188F-1670254873", EditSequence: "7" })
    );
    expect(lastUpdateFor(updateQbItemPipelines, "row1")).toEqual(
      expect.objectContaining({
        status: "waiting",
        op_action: "mod",
        recovery_mode: "none",
        submit_count: 2,
      })
    );
  });

  it("Phase B (normal retry): a mod with a legitimate SalesPrice of 0 IS sent (no recovery override)", async () => {
    const errorRow: Row = {
      id: "row1",
      variant_id: "var_1",
      sku: "FREE-SAMPLE",
      op_action: "mod",
      qb_id: "8000188F-1670254873",
      op_payload: {
        Name: "FREE-SAMPLE",
        ListID: "8000188F-1670254873",
        EditSequence: "7",
        SalesPrice: 0,
      },
      retries: 0,
      submit_count: 1,
      recovery_mode: "none",
      last_error: "Bridge 500 — transient", // NOT an EditSequence error
      next_retry_at: null,
    };
    const { container, updateQbItemPipelines } = buildContainer({
      error: [errorRow],
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ operationId: "mod-2" }),
      text: async () => "",
    });
    global.fetch = fetchMock as any;

    await qbItemPipelinePoller(container);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    // A real $0 edit on a normal retry must reach QB (no recovery guardrail here).
    expect(sentBody.data).toHaveProperty("SalesPrice", 0);
    expect(lastUpdateFor(updateQbItemPipelines, "row1")).toEqual(
      expect.objectContaining({ status: "waiting", submit_count: 2 })
    );
  });
});
