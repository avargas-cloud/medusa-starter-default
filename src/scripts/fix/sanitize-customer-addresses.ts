/**
 * sanitize-customer-addresses.ts
 *
 * One-off backfill that normalizes every customer_address row to the canonical
 * format: street-type / directional / unit-type / state abbreviations are
 * UPPERCASE, everything else is Title Case.
 *
 *   Before:  "3245 ne 184 st Unidad 13304"  /  "aventura"  /  "fl"
 *   After:   "3245 NE 184 ST Unidad 13304"  /  "Aventura"  /  "FL"
 *
 * Also runs the same transformation over snapshots inside pos_invoice and
 * pos_credit_memo (raw_shipping_address / raw_billing_address JSONB columns)
 * so historical documents render cleanly.
 *
 * Usage:
 *   DRY RUN:  yarn medusa exec ./src/scripts/fix/sanitize-customer-addresses.ts
 *   APPLY:    APPLY=1 yarn medusa exec ./src/scripts/fix/sanitize-customer-addresses.ts
 */
import { MedusaContainer } from "@medusajs/framework/types";

import { formatAddressLine } from "../../lib/format-address";

type Row = {
  id: string;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  province: string | null;
};

function diff(before: Row, after: Row): Array<[keyof Row, string, string]> {
  const out: Array<[keyof Row, string, string]> = [];
  (["address_1", "address_2", "city", "province"] as const).forEach((k) => {
    const b = before[k] ?? "";
    const a = after[k] ?? "";
    if (b !== a) out.push([k, b, a]);
  });
  return out;
}

function normalizeRow(r: Row): Row {
  return {
    id: r.id,
    address_1: r.address_1 ? formatAddressLine(r.address_1) : r.address_1,
    address_2: r.address_2 ? formatAddressLine(r.address_2) : r.address_2,
    city: r.city ? formatAddressLine(r.city) : r.city,
    province: r.province ? r.province.toUpperCase() : r.province,
  };
}

export default async function sanitizeCustomerAddresses({
  container,
}: {
  container: MedusaContainer;
}) {
  const apply = process.env.APPLY === "1";
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as any;

  const rows: Row[] = await pg("customer_address").select(
    "id",
    "address_1",
    "address_2",
    "city",
    "province"
  );

  logger.info(`[sanitize-addresses] Scanning ${rows.length} customer_address rows...`);

  let changed = 0;
  for (const row of rows) {
    const normalized = normalizeRow(row);
    const d = diff(row, normalized);
    if (d.length === 0) continue;
    changed++;

    if (changed <= 20) {
      logger.info(`[sanitize-addresses] ${row.id}:`);
      for (const [k, b, a] of d) {
        logger.info(`    ${k}: "${b}" → "${a}"`);
      }
    }

    if (apply) {
      await pg("customer_address")
        .where({ id: row.id })
        .update({
          address_1: normalized.address_1,
          address_2: normalized.address_2,
          city: normalized.city,
          province: normalized.province,
        });
    }
  }

  // Also normalize qb_vendor addresses. Column names differ (addr1/addr2 +
  // state in place of province) so we use a dedicated loop.
  const vendorRows: Array<{
    id: string;
    addr1: string | null;
    addr2: string | null;
    city: string | null;
    state: string | null;
  }> = await pg("qb_vendor").select("id", "addr1", "addr2", "city", "state");
  let vendorChanged = 0;
  for (const v of vendorRows) {
    const next = {
      addr1: v.addr1 ? formatAddressLine(v.addr1) : v.addr1,
      addr2: v.addr2 ? formatAddressLine(v.addr2) : v.addr2,
      city: v.city ? formatAddressLine(v.city) : v.city,
      state: v.state ? v.state.toUpperCase() : v.state,
    };
    const anyChanged =
      next.addr1 !== v.addr1 ||
      next.addr2 !== v.addr2 ||
      next.city !== v.city ||
      next.state !== v.state;
    if (!anyChanged) continue;
    vendorChanged++;
    if (vendorChanged <= 10) {
      logger.info(
        `[sanitize-addresses] vendor ${v.id}: ` +
          `addr1 "${v.addr1 ?? ""}" → "${next.addr1 ?? ""}", ` +
          `city "${v.city ?? ""}" → "${next.city ?? ""}", ` +
          `state "${v.state ?? ""}" → "${next.state ?? ""}"`
      );
    }
    if (apply) {
      await pg("qb_vendor").where({ id: v.id }).update(next);
    }
  }
  logger.info(
    `[sanitize-addresses] qb_vendor: ${vendorChanged} / ${vendorRows.length} row(s) ${apply ? "updated" : "would be updated"}`
  );

  // Snapshot JSONB columns on POS documents (pos_invoice, pos_credit_memo)
  // carry their own copy of the address at the moment the document was created.
  // We normalize those too so historical prints match live UI.
  const snapshotTargets: Array<{ table: string; column: string }> = [
    { table: "pos_invoice", column: "raw_shipping_address" },
    { table: "pos_invoice", column: "raw_billing_address" },
    { table: "pos_credit_memo", column: "raw_shipping_address" },
    { table: "pos_credit_memo", column: "raw_billing_address" },
  ];

  for (const { table, column } of snapshotTargets) {
    // Check the column exists before touching it (some tables don't have both).
    const colCheck = await pg.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_name = ? AND column_name = ?`,
      [table, column]
    );
    if (colCheck.rows.length === 0) continue;

    const snapRows: Array<{ id: string; snap: any }> = await pg(table).select(
      "id",
      `${column} as snap`
    );
    let snapChanged = 0;
    for (const r of snapRows) {
      if (!r.snap || typeof r.snap !== "object") continue;
      const original = r.snap as Record<string, any>;
      const next = {
        ...original,
        address_1: original.address_1
          ? formatAddressLine(original.address_1)
          : original.address_1,
        address_2: original.address_2
          ? formatAddressLine(original.address_2)
          : original.address_2,
        city: original.city ? formatAddressLine(original.city) : original.city,
        province: original.province ? String(original.province).toUpperCase() : original.province,
      };
      if (JSON.stringify(next) === JSON.stringify(original)) continue;
      snapChanged++;
      if (apply) {
        await pg(table)
          .where({ id: r.id })
          .update({ [column]: next });
      }
    }
    logger.info(
      `[sanitize-addresses] ${table}.${column}: ${snapChanged} snapshot row(s) ${apply ? "updated" : "would be updated"}`
    );
  }

  logger.info(
    `[sanitize-addresses] ${changed} / ${rows.length} customer_address rows ${apply ? "updated" : "would be updated"}.`
  );
  if (!apply) {
    logger.warn(
      "[sanitize-addresses] DRY RUN — re-run with APPLY=1 to execute."
    );
  }
}
