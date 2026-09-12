/**
 * upsertItemPipelineRow (src/lib/quickbooks/upsert-item-pipeline-row.ts) must
 * skip the qb_item_pipeline write entirely when QB_SYNC_ENABLED=false.
 */
import { upsertItemPipelineRow } from "../../lib/quickbooks/upsert-item-pipeline-row";

function untouchedCatalog() {
  return {
    listQbItemPipelines: jest.fn(async () => {
      throw new Error("listQbItemPipelines called — gate did not fire");
    }),
    createQbItemPipelines: jest.fn(async () => {
      throw new Error("createQbItemPipelines called — gate did not fire");
    }),
    updateQbItemPipelines: jest.fn(async () => {
      throw new Error("updateQbItemPipelines called — gate did not fire");
    }),
    softDeleteQbItemPipelines: jest.fn(async () => {
      throw new Error("softDeleteQbItemPipelines called — gate did not fire");
    }),
  };
}

describe("upsertItemPipelineRow — QB_SYNC_ENABLED=false", () => {
  const ORIGINAL = process.env.QB_SYNC_ENABLED;

  beforeEach(() => {
    process.env.QB_SYNC_ENABLED = "false";
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.QB_SYNC_ENABLED;
    else process.env.QB_SYNC_ENABLED = ORIGINAL;
  });

  it("returns a fabricated id without calling the catalog service", async () => {
    const catalog = untouchedCatalog();
    const result = await upsertItemPipelineRow(catalog, {
      variant_id: "variant_1",
      sku: "SKU-1",
      op_action: "add",
    });
    expect(result.reused).toBe(false);
    expect(typeof result.id).toBe("string");
    expect(catalog.listQbItemPipelines).not.toHaveBeenCalled();
    expect(catalog.createQbItemPipelines).not.toHaveBeenCalled();
  });

  it("also skips for op_action: mod", async () => {
    const catalog = untouchedCatalog();
    const result = await upsertItemPipelineRow(catalog, {
      variant_id: "variant_1",
      sku: "SKU-1",
      op_action: "mod",
    });
    expect(result.reused).toBe(false);
    expect(catalog.createQbItemPipelines).not.toHaveBeenCalled();
  });
});
