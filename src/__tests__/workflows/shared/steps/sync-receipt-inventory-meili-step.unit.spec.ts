/**
 * Unit tests for syncReceiptInventoryMeiliStep
 *
 * Key behaviors under test:
 *   • Empty ID list → no calls, returns synced:0
 *   • N items → N calls to syncInventoryItemToMeiliSearchWorkflow
 *   • Partial failure → allSettled keeps going, counts correctly
 *   • Full failure → does NOT throw, just counts
 *   • Logger receives warn per failure, info on completion
 */

// ─── SDK mock (must be before imports) ────────────────────────────────────────
// createStep is mocked to return the inner function directly so we can call it.

jest.mock("@medusajs/framework/workflows-sdk", () => ({
  createStep: (_name: string, fn: unknown) => fn,
  StepResponse: class StepResponse {
    data: unknown;
    constructor(data: unknown) {
      this.data = data;
    }
  },
}));

// ─── Workflow dependency mock ──────────────────────────────────────────────────
// Factory uses inline jest.fn() — can't reference outer vars here (hoisting).

jest.mock("../../../../workflows/sync-inventory-item-meilisearch", () => ({
  syncInventoryItemToMeiliSearchWorkflow: jest.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../workflows/sync-inventory-item-meilisearch";
import { syncReceiptInventoryMeiliStep } from "../../../../workflows/shared/steps/sync-receipt-inventory-meili-step";

// ─── Typed references ─────────────────────────────────────────────────────────

type StepFn = (
  input: { inventory_item_ids: string[] },
  ctx: { container: ReturnType<typeof buildContainer> }
) => Promise<{ data: { synced: number; failed: number } }>;

const stepFn = syncReceiptInventoryMeiliStep as unknown as StepFn;
const mockSyncWorkflow = syncInventoryItemToMeiliSearchWorkflow as jest.Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildContainer() {
  const logger = { info: jest.fn(), warn: jest.fn() };
  return { resolve: jest.fn((key: string) => (key === "logger" ? logger : null)), logger };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("syncReceiptInventoryMeiliStep", () => {
  let mockRun: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRun = jest.fn().mockResolvedValue({ result: { synced: 1, deleted: 0 } });
    mockSyncWorkflow.mockReturnValue({ run: mockRun });
  });

  // ── Empty input ───────────────────────────────────────────────────────────

  it("returns synced:0, failed:0 and makes no workflow calls for empty list", async () => {
    const { resolve } = buildContainer();
    const result = await stepFn({ inventory_item_ids: [] }, { container: { resolve } });

    expect(mockSyncWorkflow).not.toHaveBeenCalled();
    expect(result.data).toEqual({ synced: 0, failed: 0 });
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("calls the sync workflow once per inventory_item_id", async () => {
    const { resolve } = buildContainer();
    await stepFn({ inventory_item_ids: ["item-1", "item-2", "item-3"] }, { container: { resolve } });

    expect(mockRun).toHaveBeenCalledTimes(3);
    expect(mockRun).toHaveBeenCalledWith({ input: { inventoryItemId: "item-1" } });
    expect(mockRun).toHaveBeenCalledWith({ input: { inventoryItemId: "item-2" } });
    expect(mockRun).toHaveBeenCalledWith({ input: { inventoryItemId: "item-3" } });
  });

  it("returns synced equal to total items when all succeed", async () => {
    const { resolve } = buildContainer();
    const result = await stepFn({ inventory_item_ids: ["item-1", "item-2"] }, { container: { resolve } });

    expect(result.data).toEqual({ synced: 2, failed: 0 });
  });

  it("passes the container to syncInventoryItemToMeiliSearchWorkflow", async () => {
    const { resolve } = buildContainer();
    const container = { resolve };
    await stepFn({ inventory_item_ids: ["item-1"] }, { container });

    expect(mockSyncWorkflow).toHaveBeenCalledWith(container);
  });

  it("handles a single item correctly", async () => {
    const { resolve } = buildContainer();
    const result = await stepFn({ inventory_item_ids: ["only-item"] }, { container: { resolve } });

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith({ input: { inventoryItemId: "only-item" } });
    expect(result.data).toEqual({ synced: 1, failed: 0 });
  });

  // ── Partial failure (allSettled) ──────────────────────────────────────────

  it("does NOT throw when one item fails — uses Promise.allSettled", async () => {
    mockRun
      .mockResolvedValueOnce({ result: { synced: 1 } })
      .mockRejectedValueOnce(new Error("Meili down"))
      .mockResolvedValueOnce({ result: { synced: 1 } });

    const { resolve } = buildContainer();
    await expect(
      stepFn({ inventory_item_ids: ["i-1", "i-2", "i-3"] }, { container: { resolve } })
    ).resolves.toBeDefined();
  });

  it("counts synced and failed correctly on partial failure", async () => {
    mockRun
      .mockResolvedValueOnce({ result: { synced: 1 } })
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ result: { synced: 1 } });

    const { resolve } = buildContainer();
    const result = await stepFn(
      { inventory_item_ids: ["i-1", "i-2", "i-3"] },
      { container: { resolve } }
    );

    expect(result.data).toEqual({ synced: 2, failed: 1 });
  });

  // ── Full failure ──────────────────────────────────────────────────────────

  it("does NOT throw when ALL items fail", async () => {
    mockRun.mockRejectedValue(new Error("Meili unreachable"));
    const { resolve } = buildContainer();

    await expect(
      stepFn({ inventory_item_ids: ["i-1", "i-2"] }, { container: { resolve } })
    ).resolves.toBeDefined();
  });

  it("returns synced:0, failed:N when all items fail", async () => {
    mockRun.mockRejectedValue(new Error("Meili unreachable"));
    const { resolve } = buildContainer();
    const result = await stepFn({ inventory_item_ids: ["i-1", "i-2"] }, { container: { resolve } });

    expect(result.data).toEqual({ synced: 0, failed: 2 });
  });

  // ── Logger behaviour ──────────────────────────────────────────────────────

  it("logs a warn for each failed item containing the error message", async () => {
    mockRun.mockRejectedValue(new Error("connection reset"));
    const { resolve, logger } = buildContainer();

    await stepFn({ inventory_item_ids: ["i-1", "i-2"] }, { container: { resolve } });

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
  });

  it("logs info with synced/total counts on success", async () => {
    const { resolve, logger } = buildContainer();
    await stepFn({ inventory_item_ids: ["i-1", "i-2"] }, { container: { resolve } });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("2/2"));
  });

  it("logs info with correct counts on partial failure", async () => {
    mockRun
      .mockResolvedValueOnce({ result: { synced: 1 } })
      .mockRejectedValueOnce(new Error("timeout"));

    const { resolve, logger } = buildContainer();
    await stepFn({ inventory_item_ids: ["i-1", "i-2"] }, { container: { resolve } });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("1/2"));
  });
});
