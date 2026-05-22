/**
 * Unit tests for receiveFactoryOrderWorkflow
 *
 * Verifies:
 *   • syncReceiptInventoryMeiliStep receives the inventory_item_ids from input.lines
 *   • Meili step runs AFTER persistFoReceiptStep (correct step order)
 *   • Duplicate IDs are forwarded without deduplication
 *   • Single-line receipts work correctly
 */

// ─── Step mocks (inline jest.fn() — no external var references) ───────────────

jest.mock("../../../workflows/factory-orders/steps/allocate-fo-receipt-sequence-step", () => ({
  allocateFoReceiptSequenceStep: jest.fn(),
}));
jest.mock("../../../workflows/factory-orders/steps/apply-fo-receipt-stock-step", () => ({
  applyFoReceiptStockStep: jest.fn(),
}));
jest.mock("../../../workflows/factory-orders/steps/persist-fo-receipt-step", () => ({
  persistFoReceiptStep: jest.fn(),
}));
jest.mock("../../../workflows/shared/steps/sync-receipt-inventory-meili-step", () => ({
  syncReceiptInventoryMeiliStep: jest.fn(),
}));

// ─── SDK mock — exposes the workflow inner function via __fn ──────────────────

jest.mock("@medusajs/framework/workflows-sdk", () => ({
  createWorkflow: (_name: string, fn: unknown) => ({ __fn: fn }),
  transform: (_deps: unknown, fn: Function) => fn(_deps),
  WorkflowResponse: class WorkflowResponse {
    constructor(public r: unknown) {}
  },
  StepResponse: class StepResponse {
    constructor(public data: unknown) {}
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { allocateFoReceiptSequenceStep } from "../../../workflows/factory-orders/steps/allocate-fo-receipt-sequence-step";
import { applyFoReceiptStockStep } from "../../../workflows/factory-orders/steps/apply-fo-receipt-stock-step";
import { persistFoReceiptStep } from "../../../workflows/factory-orders/steps/persist-fo-receipt-step";
import { syncReceiptInventoryMeiliStep } from "../../../workflows/shared/steps/sync-receipt-inventory-meili-step";
import { receiveFactoryOrderWorkflow } from "../../../workflows/factory-orders/receive-factory-order";
import type { ReceiveFactoryOrderWorkflowInput } from "../../../workflows/factory-orders/receive-factory-order";

// ─── Typed mock references ────────────────────────────────────────────────────

const mockAllocateSeq = allocateFoReceiptSequenceStep as jest.Mock;
const mockApplyStock = applyFoReceiptStockStep as jest.Mock;
const mockPersistReceipt = persistFoReceiptStep as jest.Mock;
const mockSyncMeili = syncReceiptInventoryMeiliStep as jest.Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runWorkflow(input: ReceiveFactoryOrderWorkflowInput) {
  return (receiveFactoryOrderWorkflow as unknown as { __fn: Function }).__fn(input);
}

function buildLine(
  overrides: Partial<ReceiveFactoryOrderWorkflowInput["lines"][0]> = {}
) {
  return {
    fo_line_id: "fol-1",
    product_variant_id: "var-1",
    inventory_item_id: "inv-1",
    sku_snapshot: "SKU-A",
    description_snapshot: "Panel 400W",
    qty_received_now: 5,
    unit_cost_cents_effective: 10000,
    unit_cost_cents_override: null,
    ...overrides,
  };
}

function buildInput(
  lineOverrides: Partial<ReceiveFactoryOrderWorkflowInput["lines"][0]>[] = [{}]
): ReceiveFactoryOrderWorkflowInput {
  return {
    fo_id: "fo-001",
    fo_number: "FO-1001",
    received_by_user_id: "usr-001",
    stock_location_id: "loc-china",
    received_at: new Date("2026-01-15"),
    notes: null,
    lines: lineOverrides.map((o, i) =>
      buildLine({ fo_line_id: `fol-${i + 1}`, inventory_item_id: `inv-${i + 1}`, ...o })
    ),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("receiveFactoryOrderWorkflow — MeiliSearch sync step", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAllocateSeq.mockReturnValue({ seq: 1, number: "FRCP-0001" });
    mockApplyStock.mockReturnValue({ applied: true });
    mockPersistReceipt.mockReturnValue({
      receipt_id: "rec-001",
      fo_status_after: "received",
      total_units_received: 10,
      total_units_ordered: 10,
    });
    mockSyncMeili.mockReturnValue({ synced: 2, failed: 0 });
  });

  it("calls syncReceiptInventoryMeiliStep with all inventory_item_ids from input.lines", () => {
    const input = buildInput([
      { inventory_item_id: "inv-aaa" },
      { inventory_item_id: "inv-bbb" },
    ]);

    runWorkflow(input);

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-aaa", "inv-bbb"],
    });
  });

  it("works with a single-line receipt", () => {
    runWorkflow(buildInput([{ inventory_item_id: "inv-single" }]));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-single"],
    });
  });

  it("forwards duplicate inventory_item_ids without deduplication", () => {
    runWorkflow(buildInput([
      { inventory_item_id: "inv-x" },
      { inventory_item_id: "inv-x" },
    ]));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-x", "inv-x"],
    });
  });

  it("calls syncReceiptInventoryMeiliStep AFTER persistFoReceiptStep", () => {
    runWorkflow(buildInput());

    const persistOrder = mockPersistReceipt.mock.invocationCallOrder[0];
    const meiliOrder = mockSyncMeili.mock.invocationCallOrder[0];
    expect(meiliOrder).toBeGreaterThan(persistOrder);
  });

  it("calls syncReceiptInventoryMeiliStep exactly once", () => {
    runWorkflow(buildInput([{}, {}, {}]));
    expect(mockSyncMeili).toHaveBeenCalledTimes(1);
  });

  it("still calls all prior steps", () => {
    runWorkflow(buildInput([{}, {}]));
    expect(mockAllocateSeq).toHaveBeenCalledTimes(1);
    expect(mockApplyStock).toHaveBeenCalledTimes(1);
    expect(mockPersistReceipt).toHaveBeenCalledTimes(1);
  });
});
