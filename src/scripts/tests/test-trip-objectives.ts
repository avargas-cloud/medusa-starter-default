#!/usr/bin/env tsx
/**
 * test-trip-objectives.ts — sandbox CRUD smoke test for the trip-objectives
 * module. Run ONLY against the sandbox DB. Exercises: create objective with
 * multiple quotes (incl. same supplier) + optional spec, observations + order,
 * Field Builder schema update, and soft-delete.
 *
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     yarn medusa exec ./src/scripts/tests/test-trip-objectives.ts
 */

import { ExecArgs } from "@medusajs/framework/types";
import { TRIP_OBJECTIVES_MODULE } from "../../modules/trip-objectives";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("❌ ASSERT FAILED: " + msg);
  console.log("  ✓ " + msg);
}

export default async function testTripObjectives({ container }: ExecArgs) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = container.resolve(TRIP_OBJECTIVES_MODULE) as any;

  console.log("\n=== 1. fixtures ===");
  const trips = await svc.listTrips({ is_active: true });
  assert(trips.length >= 1, "active trip exists");
  const tripId = trips[0].id;

  const cats = await svc.listTripObjectiveCategories({ slug: "sourcing" });
  assert(cats.length === 1, "sourcing category exists");
  const cat = cats[0];
  const qScoped = (cat.field_schema as Array<{ scope?: string }>).filter(
    (f) => f.scope === "quote"
  );
  assert(qScoped.length > 0, `sourcing has quote-scoped fields (${qScoped.length})`);

  console.log("\n=== 2. create objective with 2 quotes (same supplier) ===");
  const obj = await svc.createTripObjectives({
    trip_id: tripId,
    category_id: cat.id,
    title: "TEST 24V LED strip 2700K",
    status_key: "quoting",
    priority: "high",
    fields: { product_category: "LED strip", target_price: 1.2 },
    active_optional_fields: [],
    quotes: [
      {
        id: "q_1",
        is_preferred: true,
        active_optional_fields: ["lumens"],
        fields: { supplier: "Fongkit", mpn: "FK-2700-24", description: "High CRI", moq: 500, cost: 1.05, lumens: 480 },
      },
      {
        id: "q_2",
        is_preferred: false,
        active_optional_fields: [],
        fields: { supplier: "Fongkit", mpn: "FK-2700-24B", description: "Std CRI", moq: 1000, cost: 0.92 },
      },
    ],
  });
  assert(!!obj.id, `objective created (${obj.id})`);
  const reread = await svc.retrieveTripObjective(obj.id);
  assert(Array.isArray(reread.quotes) && reread.quotes.length === 2, "2 quotes persisted");
  const suppliers = reread.quotes.map((q: { fields?: { supplier?: string } }) => q.fields?.supplier);
  assert(suppliers[0] === "Fongkit" && suppliers[1] === "Fongkit", "same supplier on both quotes allowed");
  assert(reread.quotes[0].fields.lumens === 480, "optional spec (lumens) persisted on quote 1");
  assert(reread.quotes.filter((q: { is_preferred?: boolean }) => q.is_preferred).length === 1, "exactly 1 preferred quote");

  console.log("\n=== 3. observations + ordering ===");
  await svc.createTripObjectiveObservations({
    objective_id: obj.id,
    occurred_at: new Date("2026-06-04T02:00:00Z").toISOString(),
    note: "First factory visit",
    parties: [{ name: "Mr. Li", type: "factory" }],
  });
  await svc.createTripObjectiveObservations({
    objective_id: obj.id,
    occurred_at: new Date("2026-06-05T06:30:00Z").toISOString(),
    note: "Negotiated price down",
    parties: [{ name: "Alejo", type: "staff" }],
  });
  const obs = await svc.listTripObjectiveObservations(
    { objective_id: obj.id },
    { order: { occurred_at: "DESC" } }
  );
  assert(obs.length === 2, "2 observations created");
  assert(
    new Date(obs[0].occurred_at).getTime() > new Date(obs[1].occurred_at).getTime(),
    "observations ordered newest-first"
  );

  console.log("\n=== 4. Field Builder: update category field_schema ===");
  const newSchema = [
    ...cat.field_schema,
    { key: "test_builder_field", label: "Test Builder", type: "text", scope: "objective", position: 999 },
  ];
  await svc.updateTripObjectiveCategories({ id: cat.id, field_schema: newSchema });
  const catAfter = await svc.retrieveTripObjectiveCategory(cat.id);
  assert(
    (catAfter.field_schema as Array<{ key: string }>).some((f) => f.key === "test_builder_field"),
    "field_schema update persisted (Field Builder)"
  );

  console.log("\n=== 5. soft-delete objective ===");
  await svc.deleteTripObjectives(obj.id);
  const listAfter = await svc.listTripObjectives({ trip_id: tripId, category_id: cat.id });
  assert(
    !listAfter.some((o: { id: string }) => o.id === obj.id),
    "deleted objective no longer in list (soft-delete)"
  );
  // Soft-delete does NOT fire the PG FK cascade (that's hard-delete only);
  // observations remain but are unreachable (their objective is gone).
  const orphanObs = await svc.listTripObjectiveObservations({ objective_id: obj.id });
  console.log(`  ℹ observations after soft-delete: ${orphanObs.length} (orphaned, invisible in UI — FK cascade only on hard delete)`);

  console.log("\n✅ ALL TRIP-OBJECTIVES SANDBOX TESTS PASSED\n");
}
