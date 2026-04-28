/**
 * Unit tests for receivePurchaseOrderWorkflow
 *
 * Verifies:
 *   • syncReceiptInventoryMeiliStep receives inventory_item_ids from input.lines
 *   • Meili step runs AFTER persistReceiptStep
 *   • Meili step runs AFTER enqueueQbItemReceiptStep (it is the last step)
 *   • Multi-line and single-line receipts both work
 */

// ─── Step mocks ───────────────────────────────────────────────────────────────

jest.mock("../steps/allocate-receipt-sequence-step", () => ({
  allocateReceiptSequenceStep: jest.fn(),
}));
jest.mock("../steps/apply-receipt-stock-step", () => ({
  applyReceiptStockStep: jest.fn(),
}));
jest.mock("../steps/persist-receipt-step", () => ({
  persistReceiptStep: jest.fn(),
}));
jest.mock("../steps/enqueue-qb-item-receipt-step", () => ({
  enqueueQbItemReceiptStep: jest.fn(),
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

import { allocateReceiptSequenceStep } from "../steps/allocate-receipt-sequence-step";
import { applyReceiptStockStep } from "../steps/apply-receipt-stock-step";
import { persistReceiptStep } from "../steps/persist-receipt-step";
import { enqueueQbItemReceiptStep } from "../steps/enqueue-qb-item-receipt-step";
import { syncReceiptInventoryMeiliStep } from "../../shared/steps/sync-receipt-inventory-meili-step";
import { receivePurchaseOrderWorkflow } from "../receive-purchase-order";
import type { ReceivePurchaseOrderWorkflowInput } from "../receive-purchase-order";

// ─── Typed mock references ────────────────────────────────────────────────────

const mockAllocateSeq = allocateReceiptSequenceStep as jest.Mock;
const mockApplyStock = applyReceiptStockStep as jest.Mock;
const mockPersistReceipt = persistReceiptStep as jest.Mock;
const mockEnqueueQb = enqueueQbItemReceiptStep as jest.Mock;
const mockSyncMeili = syncReceiptInventoryMeiliStep as jest.Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runWorkflow(input: ReceivePurchaseOrderWorkflowInput) {
  return (receivePurchaseOrderWorkflow as unknown as { __fn: Function }).__fn(input);
}

function buildLine(
  overrides: Partial<ReceivePurchaseOrderWorkflowInput["lines"][0]> = {}
) {
  return {
    po_line_id: "pol-1",
    product_variant_id: "var-1",
    inventory_item_id: "inv-1",
    sku_snapshot: "SKU-A",
    description_snapshot: "Panel 400W",
    qb_item_list_id_snapshot: "QB-LIST-001",
    qb_po_txn_line_id: "QB-TXN-LINE-001",
    qty_received_now: 3,
    unit_cost_cents_effective: 15000,
    unit_cost_cents_override: null,
    ...overrides,
  };
}

function buildInput(
  lineOverrides: Partial<ReceivePurchaseOrderWorkflowInput["lines"][0]>[] = [{}]
): ReceivePurchaseOrderWorkflowInput {
  return {
    po_id: "po-001",
    po_number: "PO-2001",
    vendor_qb_list_id: "QB-VENDOR-001",
    vendor_name: "Solar Supplies Co",
    qb_po_list_id: "QB-PO-LIST-001",
    qb_inventory_site_list_id: "QB-SITE-001",
    received_by_user_id: "usr-001",
    stock_location_id: "loc-main",
    received_at: new Date("2026-01-20"),
    vendor_bill_number: "BILL-001",
    vendor_bill_date: new Date("2026-01-19"),
    notes: null,
    qb_memo: "PO-2001 bill#BILL-001",
    lines: lineOverrides.map((o, i) =>
      buildLine({ po_line_id: `pol-${i + 1}`, inventory_item_id: `inv-${i + 1}`, ...o })
    ),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("receivePurchaseOrderWorkflow — MeiliSearch sync step", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAllocateSeq.mockReturnValue({ seq: 1, number: "RCP-0001" });
    mockApplyStock.mockReturnValue({ applied: true });
    mockPersistReceipt.mockReturnValue({
      receipt_id: "rec-po-001",
      po_status_after: "received",
      total_units_received: 6,
      total_units_ordered: 6,
      receipt_line_ids: ["rcl-1", "rcl-2"],
    });
    mockEnqueueQb.mockReturnValue({ pipeline_id: "pipe-001" });
    mockSyncMeili.mockReturnValue({ synced: 2, failed: 0 });
  });

  it("calls syncReceiptInventoryMeiliStep with inventory_item_ids from input.lines", () => {
    runWorkflow(buildInput([
      { inventory_item_id: "inv-aaa" },
      { inventory_item_id: "inv-bbb" },
    ]));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-aaa", "inv-bbb"],
    });
  });

  it("works with a single-line PO receipt", () => {
    runWorkflow(buildInput([{ inventory_item_id: "inv-single" }]));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-single"],
    });
  });

  it("handles three distinct inventory item IDs", () => {
    runWorkflow(buildInput([
      { inventory_item_id: "inv-x" },
      { inventory_item_id: "inv-y" },
      { inventory_item_id: "inv-z" },
    ]));

    expect(mockSyncMeili).toHaveBeenCalledWith({
      inventory_item_ids: ["inv-x", "inv-y", "inv-z"],
    });
  });

  it("calls syncReceiptInventoryMeiliStep AFTER persistReceiptStep", () => {
    runWorkflow(buildInput());

    const persistOrder = mockPersistReceipt.mock.invocationCallOrder[0];
    const meiliOrder = mockSyncMeili.mock.invocationCallOrder[0];
    expect(meiliOrder).toBeGreaterThan(persistOrder);
  });

  it("calls syncReceiptInventoryMeiliStep AFTER enqueueQbItemReceiptStep", () => {
    runWorkflow(buildInput());

    const qbOrder = mockEnqueueQb.mock.invocationCallOrder[0];
    const meiliOrder = mockSyncMeili.mock.invocationCallOrder[0];
    expect(meiliOrder).toBeGreaterThan(qbOrder);
  });

  it("calls syncReceiptInventoryMeiliStep exactly once", () => {
    runWorkflow(buildInput([{}, {}, {}]));
    expect(mockSyncMeili).toHaveBeenCalledTimes(1);
  });

  it("still runs all prior steps", () => {
    runWorkflow(buildInput([{}, {}]));
    expect(mockAllocateSeq).toHaveBeenCalledTimes(1);
    expect(mockApplyStock).toHaveBeenCalledTimes(1);
    expect(mockPersistReceipt).toHaveBeenCalledTimes(1);
    expect(mockEnqueueQb).toHaveBeenCalledTimes(1);
  });
});
