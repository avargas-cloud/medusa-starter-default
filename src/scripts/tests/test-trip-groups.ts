#!/usr/bin/env tsx
/**
 * test-trip-groups.ts — sandbox smoke test for per-category groups.
 * Sets groups on Sourcing (Field Builder), creates entries assigned to groups,
 * verifies persistence + filtering. Sandbox only.
 */

import { ExecArgs } from "@medusajs/framework/types";
import { TRIP_OBJECTIVES_MODULE } from "../../modules/trip-objectives";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("❌ ASSERT FAILED: " + msg);
  console.log("  ✓ " + msg);
}

export default async function testTripGroups({ container }: ExecArgs) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = container.resolve(TRIP_OBJECTIVES_MODULE) as any;

  const [trip] = await svc.listTrips({ is_active: true });
  const [cat] = await svc.listTripObjectiveCategories({ slug: "sourcing" });

  console.log("\n=== 1. define groups (Field Builder) ===");
  const groups = [
    { id: "g_linear", label: "Linear / Strips", position: 10 },
    { id: "g_drivers", label: "Drivers / PSU", position: 20 },
  ];
  await svc.updateTripObjectiveCategories({ id: cat.id, groups });
  const catAfter = await svc.retrieveTripObjectiveCategory(cat.id);
  assert(
    Array.isArray(catAfter.groups) && catAfter.groups.length === 2,
    "category groups persisted"
  );

  console.log("\n=== 2. create entries in groups ===");
  const a = await svc.createTripObjectives({
    trip_id: trip.id, category_id: cat.id, group_id: "g_linear",
    title: "GROUPTEST strip", status_key: "identified", priority: "normal", fields: {}, quotes: [],
  });
  const b = await svc.createTripObjectives({
    trip_id: trip.id, category_id: cat.id, group_id: "g_drivers",
    title: "GROUPTEST driver", status_key: "identified", priority: "normal", fields: {}, quotes: [],
  });
  const c = await svc.createTripObjectives({
    trip_id: trip.id, category_id: cat.id,
    title: "GROUPTEST ungrouped", status_key: "identified", priority: "normal", fields: {}, quotes: [],
  });

  const ra = await svc.retrieveTripObjective(a.id);
  assert(ra.group_id === "g_linear", "entry A assigned to g_linear");

  console.log("\n=== 3. filter by group ===");
  const linear = await svc.listTripObjectives({ category_id: cat.id, group_id: "g_linear" });
  assert(
    linear.some((o: { id: string }) => o.id === a.id) &&
      !linear.some((o: { id: string }) => o.id === b.id),
    "list filtered by group_id returns only that group"
  );

  console.log("\n=== 4. reassign group ===");
  await svc.updateTripObjectives({ id: c.id, group_id: "g_drivers" });
  const rc = await svc.retrieveTripObjective(c.id);
  assert(rc.group_id === "g_drivers", "entry reassigned to a group");

  console.log("\n=== cleanup ===");
  for (const id of [a.id, b.id, c.id]) await svc.deleteTripObjectives(id);
  console.log("  ✓ test entries soft-deleted");

  console.log("\n✅ TRIP GROUPS SANDBOX TESTS PASSED\n");
}
