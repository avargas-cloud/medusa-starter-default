/**
 * src/scripts/migrations/seed-acquisition-channel-defaults.ts
 *
 * Seeds the initial "Acquisition Channel" options under the Customer Defaults
 * context in system_defaults.
 *
 * Los valores coinciden exactamente con el QuickBooks custom field
 * "Distribution Channel" — no hay normalización de strings.
 *
 * Idempotent: checks whether each (context, field_name, value) row
 * already exists before inserting. Safe to rerun.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/migrations/seed-acquisition-channel-defaults.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";

const OPTIONS = [
  "Sign",
  "Online Search",
  "Online E-Commerce",
  "Referred",
  "Field Visit",
  "Email Marketing",
  "Facebook",
  "Instagram",
  "Ebay",
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
       WHERE context = 'Customer Defaults'
         AND field_name = 'Acquisition Channel'
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
         (gen_random_uuid(), 'Customer Defaults', 'Acquisition Channel', ?, ?, 'customers', now(), now());`,
      [value, sortOrder]
    );
    inserted += 1;
    console.log(`  ✓ ${sortOrder}. ${value}`);
  }

  console.log(
    `\nAcquisition Channel seed: ${inserted} inserted, ${skipped} already present.`
  );
}
