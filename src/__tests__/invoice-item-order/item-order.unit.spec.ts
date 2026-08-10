import { sortDocItemsByInsertion } from "../../api/admin/invoices/_lib/item-order";

/**
 * Ordering contract for invoice / credit-memo line display (2026-08-10).
 *
 * ULIDs are monotonic across milliseconds but RANDOM within one, and item
 * batches routinely land in a single ms — so `id` ASC alone cannot restore
 * insertion order. `sort_order` is the durable position; `id` is only the
 * legacy fallback.
 */
describe("sortDocItemsByInsertion", () => {
  it("orders by sort_order when present, ignoring id order", () => {
    // ids deliberately shuffled relative to sort_order — the same-ms ULID case
    const items = [
      { id: "01A", sort_order: 2 },
      { id: "01B", sort_order: 0 },
      { id: "01C", sort_order: 1 },
    ];
    expect(sortDocItemsByInsertion(items).map((i) => i.sort_order)).toEqual([
      0, 1, 2,
    ]);
  });

  it("falls back to id ASC for legacy rows (sort_order null/undefined)", () => {
    const items = [
      { id: "01C", sort_order: null },
      { id: "01A", sort_order: null },
      { id: "01B" as string | null },
    ];
    expect(sortDocItemsByInsertion(items).map((i) => i.id)).toEqual([
      "01A",
      "01B",
      "01C",
    ]);
  });

  it("puts rows with sort_order before legacy rows", () => {
    const items = [
      { id: "01A", sort_order: null },
      { id: "01Z", sort_order: 0 },
    ];
    expect(sortDocItemsByInsertion(items).map((i) => i.id)).toEqual([
      "01Z",
      "01A",
    ]);
  });

  it("handles empty and null input", () => {
    expect(sortDocItemsByInsertion(null)).toEqual([]);
    expect(sortDocItemsByInsertion(undefined)).toEqual([]);
    expect(sortDocItemsByInsertion([])).toEqual([]);
  });
});
