import { buildReceiptLines } from "../lines/receipt";
import { fakePurchaseAccountMap, sumCredits, sumDebits } from "./fixtures";

describe("buildReceiptLines", () => {
  const map = fakePurchaseAccountMap();

  it("debits inventory_asset and credits inventory_offset for qty × cost", () => {
    const lines = buildReceiptLines(
      { lines: [{ qtyReceivedNow: 3, unitCostCents: 500n }] },
      map
    );
    expect(lines.find((l) => l.role === "inventory_asset")?.debit_cents).toBe(1500n);
    expect(lines.find((l) => l.role === "inventory_offset")?.credit_cents).toBe(1500n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("sums multiple lines at different costs", () => {
    const lines = buildReceiptLines(
      {
        lines: [
          { qtyReceivedNow: 2, unitCostCents: 100n },
          { qtyReceivedNow: 5, unitCostCents: 300n },
        ],
      },
      map
    );
    expect(lines.find((l) => l.role === "inventory_asset")?.debit_cents).toBe(1700n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("a zero total (qty or cost zero) produces no lines — the loader treats this as skipped", () => {
    const lines = buildReceiptLines({ lines: [{ qtyReceivedNow: 0, unitCostCents: 500n }] }, map);
    expect(lines).toHaveLength(0);
  });
});
