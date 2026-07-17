/**
 * Unit tests for getVariantAvgCostBatch — the cost-snapshot helper used at
 * pos_invoice_item / pos_credit_memo_item creation.
 */

import { getVariantAvgCostBatch } from "../../../lib/cost/get-variant-avg-cost";
import type { MedusaContainer } from "@medusajs/framework/types";

type RawFn = jest.Mock<
  Promise<{ rows: Array<Record<string, unknown>> }>,
  [string, unknown[]?]
>;

function makeContainer(rawFn: RawFn): MedusaContainer {
  return {
    resolve: (key: string) => {
      if (key === "__pg_connection__") return { raw: rawFn };
      throw new Error(`unexpected resolve(${key})`);
    },
  } as unknown as MedusaContainer;
}

describe("getVariantAvgCostBatch", () => {
  it("returns empty Map when no variant ids passed", async () => {
    const raw: RawFn = jest.fn();
    const container = makeContainer(raw);

    const result = await getVariantAvgCostBatch(container, []);

    expect(result.size).toBe(0);
    expect(raw).not.toHaveBeenCalled();
  });

  it("dedupes variant ids before querying", async () => {
    const raw: RawFn = jest.fn().mockResolvedValue({
      rows: [
        { id: "var_1", qb_avg_cost: "5.50", qb_avg_cost_synced_at: null },
      ],
    });
    const container = makeContainer(raw);

    await getVariantAvgCostBatch(container, ["var_1", "var_1", "var_1"]);

    expect(raw).toHaveBeenCalledTimes(1);
    const args = raw.mock.calls[0]![1] as unknown[];
    expect(args[0]).toEqual(["var_1"]);
  });

  it("parses numeric cost and ISO timestamp from metadata", async () => {
    const raw: RawFn = jest.fn().mockResolvedValue({
      rows: [
        {
          id: "var_1",
          qb_avg_cost: "8.06455",
          qb_avg_cost_synced_at: "2026-05-08T20:00:00Z",
        },
      ],
    });
    const container = makeContainer(raw);

    const result = await getVariantAvgCostBatch(container, ["var_1"]);

    const entry = result.get("var_1")!;
    expect(entry.cost).toBeCloseTo(8.06455, 5);
    expect(entry.synced_at).toBeInstanceOf(Date);
    expect(entry.synced_at!.toISOString()).toBe("2026-05-08T20:00:00.000Z");
  });

  it("returns null cost when metadata field is missing or blank", async () => {
    const raw: RawFn = jest.fn().mockResolvedValue({
      rows: [
        { id: "var_a", qb_avg_cost: null, qb_avg_cost_synced_at: null },
        { id: "var_b", qb_avg_cost: "", qb_avg_cost_synced_at: null },
        { id: "var_c", qb_avg_cost: "not-a-number", qb_avg_cost_synced_at: null },
      ],
    });
    const container = makeContainer(raw);

    const result = await getVariantAvgCostBatch(container, ["var_a", "var_b", "var_c"]);

    expect(result.get("var_a")!.cost).toBeNull();
    expect(result.get("var_b")!.cost).toBeNull();
    expect(result.get("var_c")!.cost).toBeNull();
  });

  it("returns null synced_at when timestamp is missing or unparseable", async () => {
    const raw: RawFn = jest.fn().mockResolvedValue({
      rows: [
        { id: "var_1", qb_avg_cost: "5", qb_avg_cost_synced_at: null },
        { id: "var_2", qb_avg_cost: "5", qb_avg_cost_synced_at: "garbage" },
      ],
    });
    const container = makeContainer(raw);

    const result = await getVariantAvgCostBatch(container, ["var_1", "var_2"]);

    expect(result.get("var_1")!.synced_at).toBeNull();
    expect(result.get("var_2")!.synced_at).toBeNull();
  });

  it("fills uniform null entries for variants not returned by the query", async () => {
    const raw: RawFn = jest.fn().mockResolvedValue({
      rows: [
        { id: "var_existing", qb_avg_cost: "3", qb_avg_cost_synced_at: null },
      ],
    });
    const container = makeContainer(raw);

    const result = await getVariantAvgCostBatch(container, ["var_existing", "var_missing"]);

    expect(result.get("var_existing")!.cost).toBe(3);
    expect(result.get("var_missing")).toEqual({ cost: null, synced_at: null, source: "none" });
  });

  it("filters out empty / falsy variant ids before querying", async () => {
    const raw: RawFn = jest.fn().mockResolvedValue({ rows: [] });
    const container = makeContainer(raw);

    await getVariantAvgCostBatch(container, ["var_1", "", null as unknown as string, undefined as unknown as string]);

    const args = raw.mock.calls[0]![1] as unknown[];
    expect(args[0]).toEqual(["var_1"]);
  });
});
