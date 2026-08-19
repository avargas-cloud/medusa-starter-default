/**
 * warehouse-levels.unit.spec.ts
 *
 * Pins the China availability rule and — just as important — pins the fact that
 * there is ONE writer of it.
 *
 * The defect this replaces: `sync-inventory.ts` (full reindex) and
 * `sync-inventory-item-meilisearch.ts` (per-item, driven by the PG trigger →
 * reconciler) each carried their own copy of the level-loading block, and the
 * copies had drifted. Bulk stored `stocked − reserved` signed; per-item wrapped
 * it in `Math.max(0, …)`. Whichever writer touched a row last decided what the
 * operator saw. Measured in production 2026-08-19: three SKUs at a genuine
 * deficit (−30, −15, −10) all reading 0 on the China Inventory list — 55 units
 * of shortfall invisible to the person sizing the replenishment order.
 *
 * A unit test on the formula alone would NOT have caught that: both copies were
 * individually plausible. What catches it is the source-level check at the
 * bottom, which fails if either workflow starts computing this again on its own.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import {
  chinaAvailableFrom,
  loadWarehouseLevelMaps,
  type InventoryLevelLike,
} from "../../lib/meilisearch/warehouse-levels";

const CHINA = "sloc_01KQ14C1CFX30EDD722BF87HDM";
const MIAMI = "sloc_01KFS2AV3TAKR141KC2D6JCGTR";

/** Stands in for the Medusa inventory module: filters by location, like the real one. */
function fakeInventoryService(
  levels: Array<InventoryLevelLike & { location_id: string }>
) {
  return {
    listInventoryLevels: async (filter: Record<string, unknown>) => {
      const ids = filter.inventory_item_id as string[] | undefined;
      return levels.filter(
        (l) =>
          l.location_id === filter.location_id &&
          (!ids || ids.includes(l.inventory_item_id ?? ""))
      );
    },
  };
}

describe("chinaAvailableFrom", () => {
  it("keeps the sign — a deficit is a deficit", () => {
    // ECTSK-RFRC1C5A on the day this rule was written.
    expect(
      chinaAvailableFrom({ stocked_quantity: -4, reserved_quantity: 26 })
    ).toBe(-30);
  });

  it("does not floor at zero", () => {
    const v = chinaAvailableFrom({
      stocked_quantity: 0,
      reserved_quantity: 10,
    });
    expect(v).toBe(-10);
    expect(v).not.toBe(0);
  });

  it("treats a missing stocked quantity as zero rather than dropping the row", () => {
    // Dropping it would report 0 for a level that is nothing but reserved —
    // precisely the case worth surfacing.
    expect(
      chinaAvailableFrom({ stocked_quantity: null, reserved_quantity: 7 })
    ).toBe(-7);
  });

  it("is plain subtraction when there is stock", () => {
    expect(
      chinaAvailableFrom({ stocked_quantity: 40, reserved_quantity: 14 })
    ).toBe(26);
  });
});

describe("loadWarehouseLevelMaps", () => {
  const levels = [
    { location_id: CHINA, inventory_item_id: "a", stocked_quantity: -4, reserved_quantity: 26 },
    { location_id: CHINA, inventory_item_id: "b", stocked_quantity: 40, reserved_quantity: 14 },
    { location_id: MIAMI, inventory_item_id: "a", stocked_quantity: 100, reserved_quantity: 9 },
    { location_id: MIAMI, inventory_item_id: "b", stocked_quantity: 0, reserved_quantity: 0 },
  ];

  it("carries the China deficit through to the map", async () => {
    const maps = await loadWarehouseLevelMaps(fakeInventoryService(levels));
    expect(maps.chinaStockMap.get("a")).toBe(-30);
    expect(maps.chinaStockMap.get("b")).toBe(26);
  });

  it("reports Miami on-hand and reserved separately, unnetted", async () => {
    const maps = await loadWarehouseLevelMaps(fakeInventoryService(levels));
    expect(maps.miamiStockMap.get("a")).toBe(100);
    expect(maps.miamiReservedMap.get("a")).toBe(9);
  });

  it("gives the SAME numbers scoped to one item as it does in bulk", async () => {
    // This is the invariant the two workflows depend on: the per-item path is a
    // filter over the same computation, never a second one.
    const bulk = await loadWarehouseLevelMaps(fakeInventoryService(levels));
    const scoped = await loadWarehouseLevelMaps(fakeInventoryService(levels), ["a"]);
    expect(scoped.chinaStockMap.get("a")).toBe(bulk.chinaStockMap.get("a"));
    expect(scoped.miamiStockMap.get("a")).toBe(bulk.miamiStockMap.get("a"));
    expect(scoped.chinaStockMap.has("b")).toBe(false);
  });

  it("skips levels with no inventory_item_id instead of keying on undefined", async () => {
    const maps = await loadWarehouseLevelMaps(
      fakeInventoryService([
        { location_id: CHINA, inventory_item_id: null, stocked_quantity: 5, reserved_quantity: 0 },
      ])
    );
    expect(maps.chinaStockMap.size).toBe(0);
  });
});

describe("no writer recomputes China availability on its own", () => {
  // The check that actually prevents the regression. Both copies were plausible
  // in isolation; what made them a bug was being two.
  const WRITERS = [
    "src/workflows/sync-inventory.ts",
    "src/workflows/sync-inventory-item-meilisearch.ts",
  ];

  it.each(WRITERS)("%s loads levels through the shared helper", (rel) => {
    const src = readFileSync(resolve(process.cwd(), rel), "utf8");
    expect(src).toContain("loadWarehouseLevelMaps");
  });

  it.each(WRITERS)("%s does not subtract reserved from stocked itself", (rel) => {
    const src = readFileSync(resolve(process.cwd(), rel), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    // The exact shape both copies used. A future paste brings it back verbatim.
    expect(src).not.toMatch(/stocked_quantity\s*\?\?\s*0\)\s*-\s*\(.*reserved_quantity/);
    expect(src).not.toMatch(/Math\.max\(\s*0,[\s\S]{0,120}reserved_quantity/);
  });
});
