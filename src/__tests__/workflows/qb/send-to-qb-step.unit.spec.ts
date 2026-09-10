/**
 * Unit tests for sendToQbStep.
 *
 * The pipeline row is the ONLY audit trail of an item operation: the poller
 * confirms the bridge result through it and writes the fresh EditSequence back
 * to the variant from it. A bridge call without its row is a QB write nobody
 * can see, confirm or retry — and the next mod hits a stale EditSequence.
 *
 * Until 2026-09-10 the step swallowed the insert failure (logger.error) and
 * dispatched anyway. That is how the MikroORM 6.6 `seq = NULL` regression
 * would have stayed invisible on every item EDIT (the create path surfaced it
 * because enqueueQbItemsStep throws).
 *
 *   • pipeline requested + insert fails → throws, bridge NOT called
 *   • pipeline requested + insert ok    → bridge called once, row gets op id
 *   • no pipeline (legacy caller)       → bridge called, no insert attempted
 *   • skip=true                          → neither insert nor bridge
 */

jest.mock("@medusajs/framework/workflows-sdk", () => ({
  createStep: (_name: string, fn: unknown) => fn,
  StepResponse: class StepResponse {
    data: unknown;
    compensation: unknown;
    constructor(data: unknown, compensation?: unknown) {
      this.data = data;
      this.compensation = compensation;
    }
  },
}));

jest.mock("@medusajs/utils", () => ({
  ContainerRegistrationKeys: { QUERY: "query" },
}));

jest.mock("../../../modules/quickbooks-catalog", () => ({
  QUICKBOOKS_CATALOG_MODULE: "quickbooks_catalog",
}));

const upsertItemPipelineRow = jest.fn();
jest.mock("../../../lib/quickbooks/upsert-item-pipeline-row", () => ({
  upsertItemPipelineRow: (...args: unknown[]) => upsertItemPipelineRow(...args),
}));

import { sendToQbStep } from "../../../workflows/qb/send-to-qb-step";

type StepFn = (
  input: Record<string, unknown>,
  ctx: { container: { resolve: jest.Mock } }
) => Promise<{ data: { operationId: string | null; pipeline_row_id: string | null; qb_op_queued: boolean } }>;

const stepFn = sendToQbStep as unknown as StepFn;

const PIPELINE = { variant_id: "variant_1", sku: "SKU-1", item_type: "Inventory" as const };
const MOD_DATA = { ListID: "8000-1", EditSequence: "SEQ-1", Name: "SKU-1" };

function build() {
  const catalog = { updateQbItemPipelines: jest.fn().mockResolvedValue({}) };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const resolve = jest.fn((key: string) => {
    if (key === "logger") return logger;
    if (key === "quickbooks_catalog") return catalog;
    throw new Error(`unexpected resolve(${key})`);
  });
  return { catalog, logger, ctx: { container: { resolve } } };
}

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ operationId: "op-123" }),
    text: async () => "",
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  process.env.QB_BRIDGE_URL = "http://bridge.test";
});

describe("sendToQbStep — pipeline row is a precondition of the bridge call", () => {
  it("pipeline insert fails → throws and the bridge is NOT called", async () => {
    const { ctx, catalog } = build();
    upsertItemPipelineRow.mockRejectedValue(
      new Error("Cannot set field 'seq' of Qb item pipeline to null")
    );

    await expect(
      stepFn({ action: "mod", data: MOD_DATA, pipeline: PIPELINE }, ctx)
    ).rejects.toThrow(/qb_item_pipeline row.*Cannot set field 'seq'/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(catalog.updateQbItemPipelines).not.toHaveBeenCalled();
  });

  it("pipeline insert ok → bridge called once and the row receives the operation id", async () => {
    const { ctx, catalog } = build();
    upsertItemPipelineRow.mockResolvedValue({ id: "qbitp_1", reused: false });

    const res = await stepFn({ action: "mod", data: MOD_DATA, pipeline: PIPELINE }, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://bridge.test/api/products/8000-1");
    expect(catalog.updateQbItemPipelines).toHaveBeenCalledWith({
      id: "qbitp_1",
      qb_operation_id: "op-123",
    });
    expect(res.data).toMatchObject({ operationId: "op-123", pipeline_row_id: "qbitp_1", qb_op_queued: true });
  });

  it("no pipeline requested (legacy caller) → bridge called, no insert attempted", async () => {
    const { ctx } = build();

    const res = await stepFn({ action: "add", data: { Name: "SKU-1" } }, ctx);

    expect(upsertItemPipelineRow).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.data).toMatchObject({ operationId: "op-123", pipeline_row_id: null, qb_op_queued: true });
  });

  it("skip=true → neither insert nor bridge", async () => {
    const { ctx } = build();

    const res = await stepFn({ action: "mod", data: MOD_DATA, pipeline: PIPELINE, skip: true }, ctx);

    expect(upsertItemPipelineRow).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({ operationId: null, qb_op_queued: false });
  });
});
