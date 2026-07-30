import {
  BILL_PAYMENT_STEPS,
  PURCHASE_PIPELINE_STEPS,
  SALES_PIPELINE_EXCLUDED_STEPS,
  salesPipelineStepScopeSql,
} from "../../lib/quickbooks/pipeline/sales-pipeline-scope";

/**
 * Regression guard for the "Failed 5 but only 1 row listed" badge bug.
 *
 * The Sales Pipeline list query excluded every step that owns a dedicated UI tab
 * (purchase, inventory adjustments, customer DataExt), but the header-badge
 * summary query excluded only `customer_data_ext`. Four failed `vendor_bill_add`
 * rows — which live in the Purchase Pipeline tab — were therefore counted in the
 * Sales badge, showing "Failed 5" above a list holding a single row.
 *
 * Both call sites now derive their scope from the same constant, so the drift is
 * structurally impossible. These tests lock that in.
 */
describe("sales pipeline step scope", () => {
  it("excludes every purchase step from the sales scope", () => {
    for (const step of PURCHASE_PIPELINE_STEPS) {
      expect(SALES_PIPELINE_EXCLUDED_STEPS).toContain(step);
    }
  });

  it("excludes the other steps that own dedicated tabs", () => {
    expect(SALES_PIPELINE_EXCLUDED_STEPS).toContain("customer_data_ext");
    expect(SALES_PIPELINE_EXCLUDED_STEPS).toContain("inventory_adjustment");
    expect(SALES_PIPELINE_EXCLUDED_STEPS).toContain(
      "void_inventory_adjustment"
    );
  });

  it("excludes every bill-payment step from the sales scope", () => {
    // The highest-volume step in the shared table: an hourly read-only BillQuery
    // per linked unpaid bill. It owns the Bill Payments tab.
    for (const step of BILL_PAYMENT_STEPS) {
      expect(SALES_PIPELINE_EXCLUDED_STEPS).toContain(step);
    }
    expect(SALES_PIPELINE_EXCLUDED_STEPS).toContain(
      "vendor_bill_payment_check"
    );
  });

  it("keeps steps that genuinely belong to the sales pipeline", () => {
    for (const step of [
      "invoice",
      "sales_receipt",
      "credit_memo",
      "credit_memo_mod",
      "payment",
      "apply_payment",
      "estimate",
      "sales_order",
    ]) {
      expect(SALES_PIPELINE_EXCLUDED_STEPS).not.toContain(step);
    }
  });

  it("has no duplicate entries", () => {
    expect(new Set(SALES_PIPELINE_EXCLUDED_STEPS).size).toBe(
      SALES_PIPELINE_EXCLUDED_STEPS.length
    );
  });

  it("builds an aliased predicate for the list query", () => {
    expect(salesPipelineStepScopeSql(3, "p")).toBe(
      "p.step <> ALL($3::text[])"
    );
  });

  it("builds an unaliased predicate for the summary query", () => {
    expect(salesPipelineStepScopeSql(1)).toBe("step <> ALL($1::text[])");
  });

  it("produces the same excluded set for list and badge call sites", () => {
    // The two queries differ only in alias and parameter index — never in scope.
    const listScope = salesPipelineStepScopeSql(2, "p");
    const badgeScope = salesPipelineStepScopeSql(1);
    expect(listScope.replace("p.", "").replace("$2", "$1")).toBe(badgeScope);
  });
});
