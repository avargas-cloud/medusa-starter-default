/**
 * Unit tests for deleteFactoryOrderReceiptWorkflow
 *
 * Verifies:
 *   • syncReceiptInventoryMeiliStep receives inventory_item_ids from lines_to_reverse
 *   • Meili step runs AFTER persistDeleteFoReceiptStep
 *   • Lines with qty_applied=0 (voided) still have their IDs forwarded
 *   • Single-line reversal works
 */

// ─── Step mocks ───────────────────────────────────────────────────────────────

jest.mock("../steps/contra-apply-fo-receipt-stock-step", () => ({
  contraApplyFoReceiptStockStep: jest.fn(),
}));
jest.mock("../steps/persist-delete-fo-receipt-step", () => ({
  persistDeleteFoReceiptStep: jest.fn(),
}));
jest.mock("../../shared/steps/sync-receipt-inventory-meili-step", () => ({
  syncReceiptInventoryMeiliStep: jest.fn(),
}));

// ─── SDK mock ─────────────────────────────────────────────────────────────────

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

import { contraApplyFoReceiptStockStep } from "../steps/contra-apply-fo-receipt-stock-step";
import { persistDeleteFoReceiptStep } from "../steps/persist-delete-fo-receipt-step";
import { syncReceiptInventoryMeiliStep } from "../../shared/steps/sync-receipt-inventory-meili-step";
import { deleteFactoryOrderReceiptWorkflow } from "../delete-factory-order-receipt";
import type { DeleteFoReceiptWorkflowInput } from "../delete-factory-order-receipt";

// ─── Typed mock references ────────────────────────────────────────────────────

const mockContraApply = contraApplyFoReceiptStockStep as jest.Mock;
const mockPersistDelete = persistDeleteFoReceiptStep as jest.Mock;
const mockSyncMeili = syncReceiptInventoryMeiliStep as jest.Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runWorkflow(input: DeleteFoReceiptWorkflowInput) {
  return (deleteFactoryOrderReceiptWorkflow as unknown as { __fn: Function }).__fn(input);
}

function buildLine(
  overrides: Partial<DeleteFoReceiptWorkflowInput["lines_to_reverse"][0]> = {}
) {
  return {
    receipt_line_id: "rcl-1",
    fo_line_id: "fol-1",
    inventory_item_id: "inv-1",
    qty_applied: 5,
    ...overrides,
  };
}

function buildInput(
  lineOverrides: Partial<DeleteFoReceiptWorkflowInput["lines_to_reverse"][0]>[] = [{}]
): DeleteFoReceiptWorkflowInput {
  return {
    receipt_id: "rec-001",
    fo_id: "fo-001",
    deleted_by_user_id: "usr-001",
    delete_reason: "Test delete",
    stock_location_id: "loc-china",
    was_already_voided: false,
    lines_to_reverse: lineOverrides.map((o, i) =>
      buildLine({ receipt_line_id: `rcl-${i + 1}`, inventory_item_id: `inv-${i + 1}`, ...o })
    ),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("deleteFactoryOrderReceiptWorkflow — MeiliSearch sync step", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContraApply.mockReturnValue({
      reversed: [
        { receipt_line_id: "rcl-1", inventory_item_id: "inv-1", qty_at_reverse_time: 5, new_stock: 0 },
      ],
    });
    mockPersistDelete.mockReturnValue({
      receipt_id: "rec-001",
      hard_deleted: true,
      fo_status_after: "submitted",
      total_units_received: 0,
    });
    mockSyncMeili.mockReturnValue({ synced: 1, failed: 0 });
  });

  it("calls syncReceiptInventoryMeiliStep with inventory_item_ids from lines_to_reverse", () => {
    runWorkflow(buildInput([
      { inventory_item_id: "inv-aaa" },
      { inventory_item_id: "inv-bbb" },
    ]));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-aaa", "inv-bbb"],
    });
  });

  it("works with a single-line reversal", () => {
    runWorkflow(buildInput([{ inventory_item_id: "inv-only" }]));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-only"],
    });
  });

  it("includes lines where qty_applied=0 (voided receipt lines)", () => {
    runWorkflow(buildInput([
      { inventory_item_id: "inv-voided", qty_applied: 0 },
      { inventory_item_id: "inv-normal", qty_applied: 3 },
    ]));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-voided", "inv-normal"],
    });
  });

  it("calls syncReceiptInventoryMeiliStep AFTER persistDeleteFoReceiptStep", () => {
    runWorkflow(buildInput());

    const persistOrder = mockPersistDelete.mock.invocationCallOrder[0];
    const meiliOrder = mockSyncMeili.mock.invocationCallOrder[0];
    expect(meiliOrder).toBeGreaterThan(persistOrder);
  });

  it("calls syncReceiptInventoryMeiliStep exactly once", () => {
    runWorkflow(buildInput([{}, {}, {}, {}]));
    expect(mockSyncMeili).toHaveBeenCalledTimes(1);
  });

  it("still calls contra-apply and persist-delete steps", () => {
    runWorkflow(buildInput([{}, {}]));
    expect(mockContraApply).toHaveBeenCalledTimes(1);
    expect(mockPersistDelete).toHaveBeenCalledTimes(1);
  });
});
