/**
 * STEP 3 — compares the repaired totals against the photo taken before the fix,
 * and produces the list of documents to deal with.
 *
 * Reading the output:
 *
 *   MATCHES THE PHOTO   the goal. The total the POS shows is still the total the
 *                       customer holds, and it is now derived correctly instead
 *                       of by hand. Nothing to do.
 *
 *   MOVED               the POS is now showing a different number than the copy
 *                       the customer already has. Every one of these needs a
 *                       decision — pin it, align its line flags, or reissue —
 *                       and that is deliberately NOT this script's job. It
 *                       names them and stops.
 *
 * Run AFTER `photo-document-totals.ts` and AFTER `recompute-order-totals.ts`.
 *
 * ── An order edited in between is not a regression ──────────────────────────
 * The photo recorded each order's `version`. If somebody edited an order during
 * the window, its total is SUPPOSED to have moved and putting it on the repair
 * list would waste the next session's time. Those are split into their own
 * section rather than dropped, because a real regression can land on an edited
 * order too and hiding the section would hide that as well.
 *
 * Read-only. Writes nothing.
 *
 *   ./node_modules/.bin/tsx src/scripts/checks/compare-totals-to-photo.ts
 *   CSV=/tmp/moved.csv ./node_modules/.bin/tsx src/scripts/checks/compare-totals-to-photo.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { Pool } from "pg";

/** Cents of slack. Zero by default — "close enough" is how a cent bug lives on. */
const TOLERANCE = Number(process.env.TOLERANCE ?? 0);
/** Optional path to dump the MOVED list for the next session to work from. */
const CSV = process.env.CSV ?? "";

function resolveDb(): string {
  if (process.env.TARGET_DB) return process.env.TARGET_DB;
  const env = readFileSync(join(process.cwd(), ".env"), "utf8");
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error("no DATABASE_URL in .env");
  return m[1]!.trim();
}

/**
 * The photo's total against today's, for all three document kinds in one pass.
 * Invoices are included as their own rows: they must not have moved at all, and
 * an invoice that did is a far more serious finding than an order that did.
 */
const COMPARE = `
SELECT p.doc_kind,
       p.ref_number,
       p.doc_id,
       p.total_source,
       p.total_cents                                        AS photo_c,
       p.order_version                                      AS photo_version,
       o.version                                            AS now_version,
       p.doc_date,
       -- The SAME precedence the photo used, or this compares two different
       -- fields and calls the difference damage: the photo took an order's
       -- pos_total, and reading computed_total here reported every order that
       -- has no computed_total as having dropped to $0.00.
       CASE p.doc_kind
         WHEN 'invoice' THEN (SELECT i.total FROM pos_invoice i WHERE i.id = p.doc_id)
         ELSE COALESCE(
                CASE WHEN p.doc_kind = 'order'
                     THEN ROUND(NULLIF(o.metadata->>'pos_total','')::numeric * 100) END,
                ROUND(NULLIF(o.metadata->>'computed_total','')::numeric * 100),
                (SELECT ROUND(COALESCE(
                          NULLIF(s2.totals->>'current_order_total','')::numeric, 0) * 100)
                   FROM order_summary s2
                  WHERE s2.order_id = p.order_id AND s2.version = o.version
                  LIMIT 1))
       END                                                  AS now_c,
       (SELECT ROUND(COALESCE(
                 NULLIF(s.totals->>'current_order_total','')::numeric, 0) * 100)
          FROM order_summary s
         WHERE s.order_id = p.order_id AND s.version = o.version
         LIMIT 1)                                           AS now_list_c
  FROM document_total_photo p
  LEFT JOIN "order" o ON o.id = p.order_id AND o.deleted_at IS NULL
 ORDER BY p.doc_kind, p.ref_number
`;

type Row = {
  doc_kind: string;
  ref_number: string | null;
  doc_id: string;
  total_source: string;
  photo_c: string;
  photo_version: number | null;
  now_version: number | null;
  doc_date: string | null;
  now_c: string | null;
  now_list_c: string | null;
};

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

async function main() {
  const url = resolveDb();
  const host = new URL(url).host;
  const local = host.includes("localhost") || host.includes("127.0.0.1");
  const pool = new Pool({
    connectionString: url,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });

  const exists = await pool.query<{ ok: boolean }>(
    `SELECT to_regclass('public.document_total_photo') IS NOT NULL AS ok`
  );
  if (!exists.rows[0]?.ok) {
    console.error(
      `\nrefusing: document_total_photo does not exist — there is no "before" to\n` +
        `compare against, so nothing here could tell a repair from a regression.\n`
    );
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const { rows } = await pool.query<Row>(COMPARE);
  console.log(`\n${host}\n  ${rows.length} document(s) photographed · tolerance ${TOLERANCE}c\n`);

  const matched = new Map<string, number>();
  const moved: Row[] = [];
  const edited: Row[] = [];
  const gone: Row[] = [];
  const listStillOff: Row[] = [];

  for (const r of rows) {
    if (r.now_c === null) {
      gone.push(r);
      continue;
    }
    const photo = Number(r.photo_c);
    const now = Number(r.now_c);
    const off = Math.abs(now - photo) > TOLERANCE;

    if (off && r.doc_kind !== "invoice" && r.now_version !== r.photo_version) {
      edited.push(r);
      continue;
    }
    if (off) {
      moved.push(r);
      continue;
    }
    matched.set(r.doc_kind, (matched.get(r.doc_kind) ?? 0) + 1);

    // The point of the whole exercise: the list and the document agreeing. A
    // document that kept its total while the list still shows another number
    // means the repair did not reach the list, which is the original bug.
    if (
      r.doc_kind !== "invoice" &&
      r.now_list_c !== null &&
      Math.abs(Number(r.now_list_c) - now) > TOLERANCE
    ) {
      listStillOff.push(r);
    }
  }

  const line = (r: Row) =>
    `    ${String(r.ref_number ?? r.doc_id).padEnd(10)} ${r.doc_kind.padEnd(9)} ` +
    `${String(r.doc_date ?? "").slice(0, 10).padEnd(11)} photo ${money(Number(r.photo_c)).padStart(13)} → ` +
    `now ${money(Number(r.now_c ?? 0)).padStart(13)}   ` +
    `(${((Number(r.now_c ?? 0) - Number(r.photo_c)) / 100).toFixed(2)})`;

  console.log("── MATCHES THE PHOTO — this is what we were after ──");
  let totalMatched = 0;
  for (const [k, n] of [...matched.entries()].sort()) {
    console.log(`    ${k.padEnd(10)} ${n}`);
    totalMatched += n;
  }
  console.log(`    ${"total".padEnd(10)} ${totalMatched}\n`);

  // A document photographed at $0.00 had no total anywhere — the fix gave it
  // one. That is not the POS contradicting the customer's copy, and counting it
  // as such buries the handful that genuinely moved under a pile of fills.
  const filled = moved.filter((r) => Number(r.photo_c) === 0);
  const reallyMoved = moved.filter((r) => Number(r.photo_c) !== 0);
  if (filled.length) {
    console.log(
      `── had no total at all, now they do (${filled.length}) — a fill, not a change ──`
    );
    console.log(filled.slice(0, 10).map(line).join("\n"));
    if (filled.length > 10) console.log(`    … ${filled.length - 10} more`);
    console.log("");
  }
  moved.length = 0;
  moved.push(...reallyMoved);

  if (moved.length) {
    const byKind = new Map<string, number>();
    for (const r of moved) byKind.set(r.doc_kind, (byKind.get(r.doc_kind) ?? 0) + 1);
    console.log(
      `── MOVED — the POS now shows a different number than the customer's copy ──`
    );
    console.log(
      `   ${moved.length} document(s): ` +
        [...byKind.entries()].map(([k, n]) => `${n} ${k}`).join(", ")
    );
    console.log(`   these are the ones to work through in the next session\n`);
    const sorted = [...moved].sort(
      (a, b) =>
        Math.abs(Number(b.now_c) - Number(b.photo_c)) -
        Math.abs(Number(a.now_c) - Number(a.photo_c))
    );
    console.log(sorted.slice(0, 60).map(line).join("\n"));
    if (sorted.length > 60) console.log(`    … ${sorted.length - 60} more`);
    console.log("");

    const invoicesMoved = moved.filter((r) => r.doc_kind === "invoice");
    if (invoicesMoved.length) {
      console.log(
        `   ⚠ ${invoicesMoved.length} of them are INVOICES. An issued invoice must never\n` +
          `     change — treat this as the first thing to look at, ahead of the rest.\n`
      );
    }

    if (CSV) {
      const csv = [
        "doc_kind,ref_number,doc_id,doc_date,photo_total,now_total,delta",
        ...sorted.map((r) =>
          [
            r.doc_kind,
            r.ref_number ?? "",
            r.doc_id,
            r.doc_date ?? "",
            (Number(r.photo_c) / 100).toFixed(2),
            (Number(r.now_c) / 100).toFixed(2),
            ((Number(r.now_c) - Number(r.photo_c)) / 100).toFixed(2),
          ].join(",")
        ),
      ].join("\n");
      writeFileSync(CSV, csv);
      console.log(`   written to ${CSV}\n`);
    }
  }

  if (listStillOff.length) {
    console.log(
      `── the document is right but the LIST still disagrees (${listStillOff.length}) ──`
    );
    console.log(
      `   the original bug, unrepaired on these — the backfill writes both, so a\n` +
        `   row here means it never ran on them or something wrote after it\n`
    );
    console.log(
      listStillOff
        .slice(0, 25)
        .map(
          (r) =>
            `    ${String(r.ref_number ?? r.doc_id).padEnd(10)} doc ${money(Number(r.now_c))} · list ${money(Number(r.now_list_c ?? 0))}`
        )
        .join("\n")
    );
    console.log("");
  }

  if (edited.length) {
    console.log(
      `── edited during the window (${edited.length}) — a moved total is expected here ──`
    );
    console.log(edited.slice(0, 25).map(line).join("\n"));
    if (edited.length > 25) console.log(`    … ${edited.length - 25} more`);
    console.log("");
  }

  if (gone.length) {
    console.log(
      `── ${gone.length} photographed document(s) can no longer be read (deleted?) ──`
    );
    console.log(
      gone.slice(0, 15).map((r) => `    ${r.ref_number ?? r.doc_id}`).join("\n") + "\n"
    );
  }

  console.log(
    moved.length === 0
      ? `✅ every document still shows the total the customer was given\n`
      : `❌ ${moved.length} document(s) now show a different total than the customer's copy\n`
  );
  if (moved.length > 0) process.exitCode = 1;

  await pool.end();
}

main().catch((e) => {
  console.error(`\naborted: ${e.message}\n`);
  process.exitCode = 1;
});
