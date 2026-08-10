/**
 * Backfill pos_invoice_item.sort_order for recent invoices whose display
 * order was shuffled by the ULID-within-one-millisecond defect (2026-08-10).
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * Invoice lines are batch-inserted in the exact order the POS sends them
 * (products + comment/header lines merged and sorted client-side), but
 * Medusa's generateEntityId uses plain ulid(): monotonic across milliseconds,
 * RANDOM within one — and a whole batch routinely lands in a single ms. The
 * 2026-07-02 read-side fix ("sort by id ASC") therefore shuffles lines
 * whenever that happens. Measured 2026-08-10: 12 of the multi-line invoices
 * issued since 2026-08-08 render in the wrong order.
 *
 * ── Ground truth ────────────────────────────────────────────────────────────
 * The order still knows the intended sequence:
 *   • merchandise lines → order_line_item.metadata.sort_order
 *     (joinable via pos_invoice_item.order_line_item_id, present since
 *     Delivery v2 / 2026-08-08 — which is exactly the affected window)
 *   • comment lines     → order.metadata.pos_comment_lines[].sortOrder,
 *     matched by exact text (only when the text is unambiguous)
 * Both share ONE ordering space, so ranking the resolved values 0..n-1 gives
 * the on-screen order the cashier built.
 *
 * ── Behavior ────────────────────────────────────────────────────────────────
 * Fail-closed per invoice: writes only when EVERY line resolves and the
 * resolved values are distinct; anything else is reported and skipped.
 * Invoices whose items already carry sort_order are skipped (idempotent).
 *
 * Usage (backend/):
 *   DRY RUN:  ./node_modules/.bin/tsx src/scripts/fix/backfill-invoice-item-sort-order.ts
 *   APPLY:    APPLY=true ./node_modules/.bin/tsx src/scripts/fix/backfill-invoice-item-sort-order.ts
 *   Window:   DAYS=8 (default) — invoices created in the last N days.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

function resolveDb(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync(join(__dirname, "../../../.env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not found");
  return line.slice("DATABASE_URL=".length).trim();
}

const APPLY = process.env.APPLY === "true";
const DAYS = Number(process.env.DAYS || 8);
if (!Number.isFinite(DAYS) || DAYS <= 0 || DAYS > 60) {
  throw new Error(`Refusing DAYS=${process.env.DAYS} — expected 1..60`);
}

type ItemRow = {
  id: string;
  description: string;
  quantity: number;
  unit_price: string;
  variant_id: string | null;
  order_line_item_id: string | null;
  sort_order: number | null;
  oli_sort: number | null;
};

async function main() {
  const pool = new Pool({ connectionString: resolveDb() });

  const colCheck = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'pos_invoice_item' AND column_name = 'sort_order'`
  );
  if (colCheck.rowCount === 0) {
    throw new Error(
      "pos_invoice_item.sort_order does not exist — deploy Migration20260810170000 first."
    );
  }

  const { rows: invoices } = await pool.query(
    `SELECT pi.id, pi.invoice_number, pi.order_id, pi.created_at::date AS day,
            o.metadata->'pos_comment_lines' AS comment_lines
       FROM pos_invoice pi
       JOIN "order" o ON o.id = pi.order_id
      WHERE pi.created_at >= now() - ($1 || ' days')::interval
        AND pi.deleted_at IS NULL
      ORDER BY pi.invoice_number`,
    [String(DAYS)]
  );

  let written = 0;
  let alreadyDone = 0;
  let skipped = 0;
  let wasBroken = 0;

  for (const inv of invoices) {
    const { rows: items } = await pool.query<ItemRow>(
      `SELECT pii.id, pii.description, pii.quantity, pii.unit_price::text,
              pii.variant_id, pii.order_line_item_id, pii.sort_order,
              (oli.metadata->>'sort_order')::int AS oli_sort
         FROM pos_invoice_item pii
         LEFT JOIN order_line_item oli ON oli.id = pii.order_line_item_id
        WHERE pii.invoice_id = $1 AND pii.deleted_at IS NULL
        ORDER BY pii.id`,
      [inv.id]
    );
    if (items.length === 0) continue;

    if (items.every((it) => it.sort_order !== null)) {
      alreadyDone++;
      continue;
    }

    // Comment lines from the order, matched by exact text — only unambiguous.
    // The POS stores pos_comment_lines as a JSON-encoded STRING inside the
    // metadata jsonb (double-encoded), so parse when it arrives as a string.
    let rawComments: unknown = inv.comment_lines;
    if (typeof rawComments === "string") {
      try {
        rawComments = JSON.parse(rawComments);
      } catch {
        rawComments = [];
      }
    }
    const comments: { text: string; sortOrder: number }[] = Array.isArray(
      rawComments
    )
      ? rawComments
      : [];
    const byText = new Map<string, number[]>();
    for (const c of comments) {
      const key = String(c.text ?? "").trim();
      byText.set(key, [...(byText.get(key) ?? []), Number(c.sortOrder)]);
    }
    const usedComment = new Set<string>();

    const resolved: { id: string; expected: number }[] = [];
    const unresolved: string[] = [];
    for (const it of items) {
      if (it.order_line_item_id !== null) {
        if (it.oli_sort === null) {
          unresolved.push(`${it.id} (order line has no sort_order)`);
        } else {
          resolved.push({ id: it.id, expected: it.oli_sort });
        }
        continue;
      }
      const looksLikeComment =
        it.variant_id === null && Number(it.unit_price) === 0;
      const key = it.description.trim();
      const candidates = looksLikeComment ? byText.get(key) : undefined;
      if (candidates && candidates.length === 1 && !usedComment.has(key)) {
        usedComment.add(key);
        resolved.push({ id: it.id, expected: candidates[0] });
      } else {
        unresolved.push(`${it.id} ("${it.description.slice(0, 40)}")`);
      }
    }

    let plan: { id: string; sort_order: number }[] | null = null;
    let reason = "";
    if (items.length === 1) {
      plan = [{ id: items[0].id, sort_order: 0 }];
    } else if (unresolved.length > 0) {
      reason = `unresolved lines: ${unresolved.join(", ")}`;
    } else {
      const values = resolved.map((r) => r.expected);
      if (new Set(values).size !== values.length) {
        reason = `duplicate expected positions: [${values.join(",")}]`;
      } else {
        plan = [...resolved]
          .sort((a, b) => a.expected - b.expected)
          .map((r, rank) => ({ id: r.id, sort_order: rank }));
      }
    }

    if (!plan) {
      skipped++;
      console.log(`SKIP  INV ${inv.invoice_number} (${inv.day}): ${reason}`);
      continue;
    }

    // Was the id-order actually wrong? (reporting only — we write either way
    // so the window becomes deterministic)
    const idOrder = items.map((it) => it.id);
    const planOrder = [...plan]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((p) => p.id);
    const broken = idOrder.join("|") !== planOrder.join("|");
    if (broken) wasBroken++;

    console.log(
      `${APPLY ? "FIX " : "PLAN"}  INV ${inv.invoice_number} (${inv.day}): ${
        items.length
      } line(s)${broken ? "  ← WAS SHUFFLED" : ""}`
    );

    if (APPLY) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const p of plan) {
          await client.query(
            `UPDATE pos_invoice_item SET sort_order = $1 WHERE id = $2`,
            [p.sort_order, p.id]
          );
        }
        await client.query("COMMIT");
        written++;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
  }

  console.log(
    `\n${APPLY ? "APPLIED" : "DRY RUN"} — window: last ${DAYS} days · ` +
      `${invoices.length} invoices · ${
        APPLY ? `${written} written` : `${invoices.length - alreadyDone - skipped} would write`
      } · ${wasBroken} were visibly shuffled · ${alreadyDone} already had sort_order · ${skipped} skipped`
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
