/**
 * src/scripts/migrations/seed-po-status-defaults.ts
 *
 * Seeds the initial "PO Status" options under the Document Defaults
 * category in system_defaults.
 *
 * Idempotent: checks whether each (context, field_name, value) row
 * already exists before inserting. Safe to rerun.
 *
 * Usage:
 *   npx medusa exec ./src/scripts/migrations/seed-po-status-defaults.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";

const OPTIONS = [
  "PO Created",
  "PO Sent",
  "PO Confirmed",
  "Pending Payment",
  "To Arrange Delivery",
  "US Customs Delay",
  "Shipped (Missing Tracking)",
  "Shipped (Waiting on Arrival)",
  "Ready for Pickup",
  "Partial Rcvd Pending Partial",
  "Need Labor",
];

export default async function seed({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const pg = container.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  };

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < OPTIONS.length; i += 1) {
    const value = OPTIONS[i];
    const sortOrder = i + 1;

    const existing = await pg.raw(
      `SELECT id FROM system_defaults
       WHERE context = 'Document Defaults'
         AND field_name = 'PO Status'
         AND value = ?
       LIMIT 1;`,
      [value]
    );

    if ((existing.rows as unknown[]).length > 0) {
      skipped += 1;
      console.log(`  · skip "${value}" — already present`);
      continue;
    }

    await pg.raw(
      `INSERT INTO system_defaults
         (id, context, field_name, value, sort_order, data_scope, created_at, updated_at)
       VALUES
         (gen_random_uuid(), 'Document Defaults', 'PO Status', ?, ?, 'purchase_orders', now(), now());`,
      [value, sortOrder]
    );
    inserted += 1;
    console.log(`  ✓ ${sortOrder}. ${value}`);
  }

  console.log(
    `\nPO Status seed: ${inserted} inserted, ${skipped} already present.`
  );
}
