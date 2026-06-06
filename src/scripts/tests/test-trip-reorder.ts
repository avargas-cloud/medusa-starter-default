#!/usr/bin/env tsx
/**
 * test-trip-reorder.ts — sandbox smoke test for drag-reorder persistence.
 * Creates entries, rewrites positions (simulating a drag), confirms the list
 * returns them in the new order. Sandbox only.
 */

import { ExecArgs } from "@medusajs/framework/types";
import { TRIP_OBJECTIVES_MODULE } from "../../modules/trip-objectives";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("❌ ASSERT FAILED: " + msg);
  console.log("  ✓ " + msg);
}

export default async function testReorder({ container }: ExecArgs) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = container.resolve(TRIP_OBJECTIVES_MODULE) as any;
  const [trip] = await svc.listTrips({ is_active: true });
  const [cat] = await svc.listTripObjectiveCategories({ slug: "negotiation" });

  console.log("\n=== create 3 entries ===");
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const o = await svc.createTripObjectives({
      trip_id: trip.id, category_id: cat.id,
      title: `REORDER ${i}`, status_key: "open", priority: "normal",
      fields: {}, quotes: [], position: (i + 1) * 10,
    });
    ids.push(o.id);
  }

  console.log("\n=== simulate drag: move last to first ===");
  // New order: [ids[2], ids[0], ids[1]] → positions 10/20/30
  const newOrder = [ids[2], ids[0], ids[1]];
  await Promise.all(
    newOrder.map((id, i) => svc.updateTripObjectives({ id, position: (i + 1) * 10 }))
  );

  const listed = (
    await svc.listTripObjectives(
      { category_id: cat.id },
      { order: { position: "ASC" } }
    )
  ).filter((o: { id: string }) => ids.includes(o.id));

  assert(listed[0].id === ids[2], "moved card is now first");
  assert(listed[1].id === ids[0] && listed[2].id === ids[1], "remaining order preserved");

  console.log("\n=== cleanup ===");
  for (const id of ids) await svc.deleteTripObjectives(id);
  console.log("  ✓ cleaned up");
  console.log("\n✅ TRIP REORDER SANDBOX TEST PASSED\n");
}
