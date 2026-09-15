/**
 * needsShapeRebuild — when a regular bill's QuickBooks document has the wrong
 * SHAPE and only a rebuild (TxnDel + fresh BillAdd) can balance it.
 *
 * Pure. It authorises deleting a QuickBooks document, so each branch is a case.
 */
import {
  needsShapeRebuild,
  type RebuildShapeFacts,
} from "../../lib/purchase-orders/vendor-bill-rebuild-shape";

const facts = (over: Partial<RebuildShapeFacts> = {}): RebuildShapeFacts => ({
  bill_type: "regular",
  in_quickbooks: true,
  qb_source: "owned",
  linked_sibling_numbers: ["VB-1143", "VB-1144"],
  persisted_clearing_count: 0,
  ...over,
});

describe("needsShapeRebuild", () => {
  it("requires a rebuild for the VB-1142 shape: in QB at raw cost, siblings linked, no clearing lines", () => {
    const d = needsShapeRebuild(facts());
    expect(d.required).toBe(true);
    // The operator has to see WHICH siblings, or the banner is a riddle.
    expect(d.reason).toContain("VB-1143");
    expect(d.reason).toContain("VB-1144");
    expect(d.reason).toMatch(/rebuild/i);
  });

  it("does NOT rebuild a bill that already has the clearing shape — a Mod refreshes it", () => {
    // VB-1128 after 09-03: clearing lines persisted, a sibling edited. That is
    // the group Mod's job (e2e §6), never a delete.
    const d = needsShapeRebuild(facts({ persisted_clearing_count: 2 }));
    expect(d.required).toBe(false);
  });

  it("does NOT rebuild a bill with no linked siblings — the local shape is right", () => {
    const d = needsShapeRebuild(facts({ linked_sibling_numbers: [] }));
    expect(d.required).toBe(false);
  });

  it("does NOT rebuild a bill that is not in QuickBooks — its Add picks the shape", () => {
    // Also the state AFTER a TxnDel: the consolidator nulls qb_txn_id, so the
    // Reconfirm that queues the fresh Add must not be refused by this rule.
    const d = needsShapeRebuild(facts({ in_quickbooks: false }));
    expect(d.required).toBe(false);
  });

  it("never rebuilds an adopted bill — the accountant's document", () => {
    const d = needsShapeRebuild(facts({ qb_source: "adopted" }));
    expect(d.required).toBe(false);
  });

  it("only applies to a regular bill", () => {
    const d = needsShapeRebuild(facts({ bill_type: "service" }));
    expect(d.required).toBe(false);
  });
});
