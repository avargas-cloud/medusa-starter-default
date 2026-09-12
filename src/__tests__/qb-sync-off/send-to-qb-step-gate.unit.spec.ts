/**
 * sendToQbStep must behave exactly like its `skip: true` branch when
 * QB_SYNC_ENABLED=false — success, no qb_item_pipeline row, no bridge call,
 * no compensation. Harness mirrors
 * src/__tests__/workflows/qb/send-to-qb-step.unit.spec.ts.
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

jest.mock("../../modules/quickbooks-catalog", () => ({
  QUICKBOOKS_CATALOG_MODULE: "quickbooks_catalog",
}));

const upsertItemPipelineRow = jest.fn();
jest.mock("../../lib/quickbooks/upsert-item-pipeline-row", () => ({
  upsertItemPipelineRow: (...args: unknown[]) => upsertItemPipelineRow(...args),
}));

import { sendToQbStep } from "../../workflows/qb/send-to-qb-step";

type StepFn = (
  input: Record<string, unknown>,
  ctx: { container: { resolve: jest.Mock } }
) => Promise<{
  data: {
    success: boolean;
    operationId: string | null;
    pipeline_row_id: string | null;
    qb_op_queued: boolean;
  };
  compensation: unknown;
}>;

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
const ORIGINAL_SYNC = process.env.QB_SYNC_ENABLED;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.QB_SYNC_ENABLED = "false";
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ operationId: "op-123" }),
    text: async () => "",
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  process.env.QB_BRIDGE_URL = "http://bridge.test";
});

afterEach(() => {
  if (ORIGINAL_SYNC === undefined) delete process.env.QB_SYNC_ENABLED;
  else process.env.QB_SYNC_ENABLED = ORIGINAL_SYNC;
});

describe("sendToQbStep — QB_SYNC_ENABLED=false", () => {
  it("returns success with no operation, no pipeline row, and NO compensation — bridge never called", async () => {
    const { ctx } = build();

    const res = await stepFn({ action: "mod", data: MOD_DATA, pipeline: PIPELINE }, ctx);

    expect(upsertItemPipelineRow).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({
      success: true,
      operationId: null,
      pipeline_row_id: null,
      qb_op_queued: false,
    });
    expect(res.compensation).toBeNull();
  });

  it("also short-circuits the add path", async () => {
    const { ctx } = build();

    const res = await stepFn({ action: "add", data: { Name: "SKU-1" } }, ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.data.success).toBe(true);
    expect(res.data.qb_op_queued).toBe(false);
  });
});
