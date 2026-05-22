/**
 * Unit tests for deletePurchaseOrderReceiptWorkflow
 *
 * Verifies:
 *   • syncReceiptInventoryMeiliStep receives inventory_item_ids from lines_to_reverse
 *   • Meili step runs AFTER persistDeleteReceiptStep
 *   • Voided lines (qty_applied=0) still forward their IDs
 *   • Works for QB-synced and non-synced receipts alike
 */

// ─── Step mocks ───────────────────────────────────────────────────────────────

jest.mock("../../../workflows/purchase-orders/steps/contra-apply-receipt-stock-step", () => ({
  contraApplyReceiptStockStep: jest.fn(),
}));
jest.mock("../../../workflows/purchase-orders/steps/persist-delete-receipt-step", () => ({
  persistDeleteReceiptStep: jest.fn(),
}));
jest.mock("../../../workflows/shared/steps/sync-receipt-inventory-meili-step", () => ({
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

import { contraApplyReceiptStockStep } from "../../../workflows/purchase-orders/steps/contra-apply-receipt-stock-step";
import { persistDeleteReceiptStep } from "../../../workflows/purchase-orders/steps/persist-delete-receipt-step";
import { syncReceiptInventoryMeiliStep } from "../../../workflows/shared/steps/sync-receipt-inventory-meili-step";
import { deletePurchaseOrderReceiptWorkflow } from "../../../workflows/purchase-orders/delete-purchase-order-receipt";
import type { DeletePoReceiptWorkflowInput } from "../../../workflows/purchase-orders/delete-purchase-order-receipt";

// ─── Typed mock references ────────────────────────────────────────────────────

const mockContraApply = contraApplyReceiptStockStep as jest.Mock;
const mockPersistDelete = persistDeleteReceiptStep as jest.Mock;
const mockSyncMeili = syncReceiptInventoryMeiliStep as jest.Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runWorkflow(input: DeletePoReceiptWorkflowInput) {
  return (deletePurchaseOrderReceiptWorkflow as unknown as { __fn: Function }).__fn(input);
}

function buildLine(
  overrides: Partial<DeletePoReceiptWorkflowInput["lines_to_reverse"][0]> = {}
) {
  return {
    receipt_line_id: "rcl-1",
    po_line_id: "pol-1",
    inventory_item_id: "inv-1",
    qty_applied: 3,
    ...overrides,
  };
}

function buildInput(
  lineOverrides: Partial<DeletePoReceiptWorkflowInput["lines_to_reverse"][0]>[] = [{}],
  options: { qb_item_receipt_list_id?: string | null; was_already_voided?: boolean } = {}
): DeletePoReceiptWorkflowInput {
  return {
    receipt_id: "rec-po-001",
    po_id: "po-001",
    deleted_by_user_id: "usr-001",
    delete_reason: "Test delete",
    stock_location_id: "loc-main",
    was_already_voided: options.was_already_voided ?? false,
    qb_item_receipt_list_id: options.qb_item_receipt_list_id ?? null,
    lines_to_reverse: lineOverrides.map((o, i) =>
      buildLine({ receipt_line_id: `rcl-${i + 1}`, inventory_item_id: `inv-${i + 1}`, ...o })
    ),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("deletePurchaseOrderReceiptWorkflow — MeiliSearch sync step", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContraApply.mockReturnValue({
      reversed: [
        { receipt_line_id: "rcl-1", inventory_item_id: "inv-1", qty_at_reverse_time: 3, new_stock: 0 },
      ],
    });
    mockPersistDelete.mockReturnValue({
      receipt_id: "rec-po-001",
      hard_deleted: true,
      qb_delete_queued: false,
      po_status_after: "submitted",
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

  it("works with a single-line reverse", () => {
    runWorkflow(buildInput([{ inventory_item_id: "inv-only" }]));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-only"],
    });
  });

  it("includes lines with qty_applied=0 (voided — stock was never applied)", () => {
    runWorkflow(buildInput([
      { inventory_item_id: "inv-voided", qty_applied: 0 },
      { inventory_item_id: "inv-normal", qty_applied: 5 },
    ]));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-voided", "inv-normal"],
    });
  });

  it("calls syncReceiptInventoryMeiliStep AFTER persistDeleteReceiptStep", () => {
    runWorkflow(buildInput());

    const persistOrder = mockPersistDelete.mock.invocationCallOrder[0];
    const meiliOrder = mockSyncMeili.mock.invocationCallOrder[0];
    expect(meiliOrder).toBeGreaterThan(persistOrder);
  });

  it("calls syncReceiptInventoryMeiliStep exactly once", () => {
    runWorkflow(buildInput([{}, {}, {}]));
    expect(mockSyncMeili).toHaveBeenCalledTimes(1);
  });

  it("runs meili sync for QB-synced receipt (qb_item_receipt_list_id present)", () => {
    runWorkflow(buildInput([{ inventory_item_id: "inv-qb" }], { qb_item_receipt_list_id: "QB-REC-001" }));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-qb"],
    });
  });

  it("runs meili sync for already-voided receipt (was_already_voided=true)", () => {
    runWorkflow(buildInput([{ inventory_item_id: "inv-void" }], { was_already_voided: true }));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-void"],
    });
  });

  it("still calls contra-apply and persist-delete steps", () => {
    runWorkflow(buildInput([{}, {}]));
    expect(mockContraApply).toHaveBeenCalledTimes(1);
    expect(mockPersistDelete).toHaveBeenCalledTimes(1);
  });
});
