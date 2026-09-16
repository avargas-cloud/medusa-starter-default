/**
 * src/scripts/verify/verify-ap-adjustments.ts — ap-rounding-cleanup-20260916
 *
 * Gate of the AP adjustment lane. Runs with tsx against DATABASE_URL:
 *   env DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/verify/verify-ap-adjustments.ts
 *
 *  §1 schema: table, kinds, directions, the GL CHECK accepts the source kind
 *  §2 the balance formula really subtracts an adjustment (probed in a
 *     transaction that is ROLLED BACK — writes nothing)
 *  §3 every live adjustment has an active GL entry whose AP line is the
 *     adjustment amount on the right side; every voided one is reversed
 *  §4 no adjustment is dated in 2025; tolerance config is sane
 *  §5 rounding adjustments never exceed the tolerance
 *  §6 (informative) how many QB-paid bills still carry a residual
 */
import { Pool, type PoolClient } from "pg";
import { computeBillBalance } from "../../lib/finance/recompute-bill-finance";
import { loadApAdjustmentConfig } from "../../lib/vendor-bill-adjustments/config";

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("verify-ap-adjustments: DATABASE_URL is not set.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });
  const client: PoolClient = await pool.connect();
  try {
    console.log("§1 schema");
    const { rows: cols } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'vendor_bill_adjustment'`
    );
    const names = new Set(cols.map((c) => c.column_name));
    check(
      "vendor_bill_adjustment exists with the expected columns",
      [
        "kind",
        "direction",
        "amount_cents",
        "account_list_id",
        "adjustment_date",
        "source_fingerprint",
        "evidence",
        "voided_at",
      ].every((c) => names.has(c))
    );
    const { rows: chk } = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'bank_journal_entry_source_kind_check'`
    );
    check(
      "bank_journal_entry source_kind CHECK accepts vendor_bill_adjustment",
      /vendor_bill_adjustment/.test(chk[0]?.def ?? "")
    );
    const { rows: uq } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_constraint WHERE conname = 'uq_vba_fingerprint'`
    );
    check("fingerprint UNIQUE constraint present", uq[0]?.n === "1");

    console.log("§2 balance formula (probe in a rolled-back transaction)");
    const { rows: probe } = await client.query<{ id: string }>(
      `SELECT id FROM vendor_bill WHERE deleted_at IS NULL AND status IN ('confirmed','synced') ORDER BY created_at DESC LIMIT 1`
    );
    if (probe[0]) {
      await client.query("BEGIN");
      try {
        const before = await computeBillBalance(client, probe[0].id);
        await client.query(
          `INSERT INTO vendor_bill_adjustment (id, vendor_bill_id, kind, direction, amount_cents, account_list_id, adjustment_date, source_fingerprint)
           VALUES ('vba_probe', $1, 'rounding', 'decrease_ap', 1, 'probe', '2026-09-12', 'probe')`,
          [probe[0].id]
        );
        const after = await computeBillBalance(client, probe[0].id);
        check(
          "a 1¢ decrease_ap adjustment lowers balance_cents by exactly 1",
          !!before &&
            !!after &&
            after.balance_cents === before.balance_cents - 1 &&
            after.adjusted_cents === before.adjusted_cents + 1,
          `${before?.balance_cents} → ${after?.balance_cents}`
        );
        await client.query(
          `UPDATE vendor_bill_adjustment SET voided_at = now() WHERE id = 'vba_probe'`
        );
        const voided = await computeBillBalance(client, probe[0].id);
        check(
          "a voided adjustment no longer counts",
          !!voided && !!before && voided.balance_cents === before.balance_cents
        );
      } finally {
        await client.query("ROLLBACK");
      }
      const { rows: gone } = await client.query(
        `SELECT 1 FROM vendor_bill_adjustment WHERE id = 'vba_probe'`
      );
      check("probe rolled back (nothing written)", gone.length === 0);
    } else {
      check("a confirmed bill exists to probe", false);
    }

    console.log("§3 every adjustment ↔ GL entry");
    const { rows: adj } = await client.query<{
      id: string;
      direction: string;
      amount_cents: string;
      voided_at: string | null;
      entry_id: string | null;
      reversed: boolean | null;
      ap_debit: string | null;
      ap_credit: string | null;
    }>(
      `SELECT a.id, a.direction, a.amount_cents::text, a.voided_at::text,
              e.id AS entry_id,
              EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id) AS reversed,
              l.debit_cents::text AS ap_debit, l.credit_cents::text AS ap_credit
         FROM vendor_bill_adjustment a
         LEFT JOIN LATERAL (
           SELECT id FROM bank_journal_entry
            WHERE source_kind = 'vendor_bill_adjustment' AND source_id = a.id AND kind = 'document'
            ORDER BY created_at DESC LIMIT 1) e ON true
         LEFT JOIN bank_journal_line l ON l.entry_id = e.id AND l.role = 'accounts_payable' AND l.deleted_at IS NULL
        WHERE a.deleted_at IS NULL`
    );
    const live = adj.filter((a) => !a.voided_at);
    const unposted = live.filter((a) => !a.entry_id || a.reversed);
    check(
      `all ${live.length} live adjustments have an active GL entry`,
      unposted.length === 0,
      unposted.map((a) => a.id).join(", ")
    );
    const wrongSide = live.filter(
      (a) =>
        a.entry_id &&
        !a.reversed &&
        (a.direction === "decrease_ap"
          ? a.ap_debit !== a.amount_cents
          : a.ap_credit !== a.amount_cents)
    );
    check(
      "AP line of each live entry matches amount and direction (decrease_ap = Dr AP, increase_ap = Cr AP)",
      wrongSide.length === 0,
      wrongSide
        .map((a) => `${a.id} ${a.direction} dr=${a.ap_debit} cr=${a.ap_credit}`)
        .join("; ")
    );
    const voidedNotReversed = adj.filter(
      (a) => a.voided_at && a.entry_id && !a.reversed
    );
    check(
      "every voided adjustment with an entry is reversed",
      voidedNotReversed.length === 0,
      voidedNotReversed.map((a) => a.id).join(", ")
    );

    console.log("§4 dates and config");
    const { rows: in2025 } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM vendor_bill_adjustment WHERE adjustment_date < '2026-01-01'`
    );
    check(
      "no adjustment dated before 2026-01-01 (2025 is closed)",
      in2025[0]?.n === "0"
    );
    const config = await loadApAdjustmentConfig(client);
    check(
      `tolerance is an integer 0..1000 (${config.toleranceCents}¢)`,
      Number.isInteger(config.toleranceCents) &&
        config.toleranceCents >= 0 &&
        config.toleranceCents <= 1000
    );
    for (const [label, listId] of [
      ["rounding", config.roundingAccountListId],
      ["price variance", config.priceVarianceAccountListId],
    ] as const) {
      if (!listId) {
        console.log(
          `  ⚠ (informativo) ${label} account not configured — the lane is off`
        );
        continue;
      }
      const { rows: acc } = await client.query(
        `SELECT 1 FROM qb_account WHERE qb_list_id = $1 AND is_active = true`,
        [listId]
      );
      check(
        `${label} account ${listId} is an active qb_account`,
        acc.length === 1
      );
    }

    console.log("§5 tolerance");
    const { rows: over } = await client.query<{
      id: string;
      amount_cents: string;
    }>(
      `SELECT id, amount_cents::text FROM vendor_bill_adjustment WHERE kind = 'rounding' AND deleted_at IS NULL AND amount_cents > $1`,
      [config.toleranceCents]
    );
    check(
      "no rounding adjustment exceeds the tolerance",
      over.length === 0,
      over.map((o) => `${o.id}=${o.amount_cents}¢`).join(", ")
    );

    console.log("§6 residual noise (informative)");
    const { rows: bills } = await client.query<{ id: string }>(
      `SELECT id FROM vendor_bill WHERE deleted_at IS NULL AND status IN ('confirmed','synced') AND qb_is_paid = true`
    );
    let noisy = 0;
    let noisyCents = 0;
    for (const b of bills) {
      const bal = await computeBillBalance(client, b.id);
      if (bal && bal.balance_cents !== 0) {
        noisy++;
        noisyCents += bal.balance_cents;
      }
    }
    console.log(
      `  ℹ QB-paid bills with a POS residual: ${noisy} (net ${noisyCents}¢) of ${bills.length}`
    );
  } finally {
    client.release();
    await pool.end();
  }
  console.log(
    `\n${failures.length === 0 ? "✅" : "❌"} verify-ap-adjustments: ${passed} ok · ${failures.length} failed`
  );
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
