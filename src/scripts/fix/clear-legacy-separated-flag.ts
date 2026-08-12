import type { MedusaContainer } from "@medusajs/framework/types";
import { Client } from "pg";

/**
 * Clears the pre-per-line `metadata.is_separated` flag on NAMED orders.
 *
 * Why a script and not the UI: `deriveSeparationStatus(lines, legacyFlag)` falls
 * back to `legacyFlag ? "full" : "none"` whenever no line carries a separated
 * quantity — so saving zeros through `POST /admin/orders/:id/separations`
 * recomputes the status as "full" all over again. An order carrying only the
 * legacy boolean cannot be un-separated from the POS at all; it shows
 * "Separated" over "0 of N units set aside" forever. (S11326, 2026-08-12.)
 *
 * Writes `is_separated: false` rather than deleting the key: Medusa deep-merges
 * JSONB, so a delete never persists. `separation_status` is written alongside so
 * the two can never disagree — same pair, same shape, and the same `||` merge the
 * separations route uses, which also fires the Meili sync trigger on `order`.
 *
 * Touches nothing else: no reservations, no stock, no order_line_separation rows,
 * no other metadata key.
 *
 * Dry-run unless APPLY=true. Orders are named explicitly — this script has no
 * "find them all" mode on purpose: 25 orders carry this flag and which of them
 * are physically set aside on a shelf is not something SQL can answer.
 *
 *   npx medusa exec ./src/scripts/fix/clear-legacy-separated-flag.ts <order_id…>
 */
export default async function clearLegacySeparatedFlag({
  args,
}: {
  container: MedusaContainer;
  args: string[];
}) {
  const ids = (args ?? []).filter((a) => a.startsWith("order_"));
  if (ids.length === 0) {
    console.log("usage: … clear-legacy-separated-flag.ts <order_id> [order_id…]");
    return;
  }

  const apply = process.env.APPLY === "true";
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    const { rows } = await db.query<{
      id: string;
      doc: string | null;
      is_separated: string | null;
      separation_status: string | null;
      rows_with_qty: string;
    }>(
      `SELECT o.id,
              o.metadata->>'document_number'   AS doc,
              o.metadata->>'is_separated'      AS is_separated,
              o.metadata->>'separation_status' AS separation_status,
              (SELECT COUNT(*) FROM order_line_separation s
                WHERE s.order_id = o.id AND s.qty > 0) AS rows_with_qty
         FROM "order" o
        WHERE o.id = ANY($1::text[]) AND o.deleted_at IS NULL`,
      [ids]
    );

    const targets: string[] = [];
    for (const id of ids) {
      const r = rows.find((x) => x.id === id);
      if (!r) {
        console.log(`${id}: NOT FOUND — skipped`);
        continue;
      }
      const label = r.doc ?? r.id;
      if (r.is_separated !== "true") {
        console.log(`${label}: is_separated is already ${r.is_separated ?? "unset"} — nothing to do`);
        continue;
      }
      // Refuse to erase a REAL separation. Only the legacy shape — flag set, no
      // line actually set aside — is safe to clear without asking a human what
      // is physically on the shelf.
      if (Number(r.rows_with_qty) > 0) {
        console.log(
          `${label}: REFUSING — ${r.rows_with_qty} line(s) carry a separated quantity. ` +
            `This is a real separation, not a legacy flag.`
        );
        continue;
      }
      console.log(
        `${label}: is_separated true → false | separation_status ${
          r.separation_status ?? "<unset>"
        } → none`
      );
      targets.push(id);
    }

    if (targets.length === 0) {
      console.log("\nNothing to change.");
      return;
    }
    if (!apply) {
      console.log(`\nDRY RUN — ${targets.length} order(s) NOT written. APPLY=true to write.`);
      return;
    }

    const res = await db.query(
      `UPDATE "order"
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = ANY($1::text[])`,
      [targets, JSON.stringify({ is_separated: false, separation_status: "none" })]
    );
    console.log(`\nAPPLIED — ${res.rowCount} order(s) updated.`);
  } finally {
    await db.end();
  }
}
