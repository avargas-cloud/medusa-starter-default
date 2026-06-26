/**
 * Unit tests for the inventory-count approval classification (pure logic).
 *
 * Encodes the delta-invariant rules:
 *   - delta_original is applied on top of LIVE stock (movement-invariant): a
 *     count taken at system=50/physical=48 (Δ=-2) still applies -2 even after
 *     interim sales/receipts moved live stock to 60 → final 58.
 *   - Negative results are ALLOWED and never blocked.
 *   - delta=0 from the count → verified; an OVERRIDE that lands on delta=0 over
 *     a real variance → overriddenZero (audited), never silent verified.
 */
import {
  classifyLines,
  type ClassifyLineInput,
} from "../../workflows/inventory-count/steps/classify-lines-step";

function line(overrides: Partial<ClassifyLineInput>): ClassifyLineInput {
  return {
    line_id: "l1",
    product_variant_id: "variant_1",
    inventory_item_id: "iitem_1",
    sku: "SKU-1",
    qty_at_count_time: 0,
    qty_counted: 0,
    delta_original: 0,
    current_stock_now: 0,
    qb_account_list_id_line: null,
    qb_account_list_id_default: "ACC-DEFAULT",
    ...overrides,
  };
}

describe("classifyLines — delta is movement-invariant", () => {
  it("applies delta_original on top of live stock (sale + PO during approval)", () => {
    // system 50, counted 48 → Δ=-2; live stock moved to 60 (sold 10, received 20).
    const out = classifyLines({
      lines: [
        line({ qty_at_count_time: 50, qty_counted: 48, delta_original: -2, current_stock_now: 60 }),
      ],
      decisions: [],
    });
    expect(out.toApply).toHaveLength(1);
    expect(out.toApply[0].effective_delta).toBe(-2);
    expect(out.toApply[0].projected_stock).toBe(58); // 60 + (-2)
    expect(out.toBlock).toHaveLength(0);
    expect(out.toVerified).toHaveLength(0);
  });

  it("allows a negative result (never blocks)", () => {
    const out = classifyLines({
      lines: [line({ delta_original: -10, current_stock_now: 2 })],
      decisions: [],
    });
    expect(out.toApply).toHaveLength(1);
    expect(out.toApply[0].effective_delta).toBe(-10);
    expect(out.toApply[0].projected_stock).toBe(-8);
    expect(out.toBlock).toHaveLength(0);
  });
});

describe("classifyLines — verified vs overridden", () => {
  it("delta=0 from the count → verified", () => {
    const out = classifyLines({
      lines: [line({ qty_at_count_time: 5, qty_counted: 5, delta_original: 0, current_stock_now: 5 })],
      decisions: [],
    });
    expect(out.toVerified).toHaveLength(1);
    expect(out.toApply).toHaveLength(0);
    expect(out.toOverriddenZero).toHaveLength(0);
  });

  it("override that zeroes a real variance → overriddenZero, NOT verified", () => {
    // line had Δ=-31; manager overrides to current stock (delta 0).
    const out = classifyLines({
      lines: [line({ delta_original: -31, current_stock_now: 30 })],
      decisions: [{ line_id: "l1", action: "override", override_delta: 0 }],
    });
    expect(out.toVerified).toHaveLength(0);
    expect(out.toApply).toHaveLength(0);
    expect(out.toOverriddenZero).toHaveLength(1);
    expect(out.toOverriddenZero[0].delta_original).toBe(-31);
  });

  it("override to a real non-zero correction → toApply + audit entry", () => {
    const out = classifyLines({
      lines: [line({ delta_original: -31, current_stock_now: 30 })],
      decisions: [{ line_id: "l1", action: "override", override_delta: -20 }],
    });
    expect(out.toApply).toHaveLength(1);
    expect(out.toApply[0].effective_delta).toBe(-20);
    expect(out.toApply[0].projected_stock).toBe(10);
    expect(out.overrides).toHaveLength(1);
    expect(out.overrides[0].delta_applied).toBe(-20);
  });
});

describe("classifyLines — skip", () => {
  it("skip excludes the line", () => {
    const out = classifyLines({
      lines: [line({ delta_original: -5, current_stock_now: 10 })],
      decisions: [{ line_id: "l1", action: "skip", override_note: "later" }],
    });
    expect(out.toSkip).toHaveLength(1);
    expect(out.toApply).toHaveLength(0);
  });
});
