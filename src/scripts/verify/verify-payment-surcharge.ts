/**
 * Gate del plan "card surcharge → GL" (2026-09-14). Read-only, sin escrituras.
 *
 * §1 `buildCustomerPaymentLines` con y sin surcharge (comportamiento puro).
 * §2 la base amount+surcharge de `depositCandidates` (misma fórmula que
 *    `DEPOSIT_RECEIPT_SQL.available_amount`).
 * §3 paridad contra el feed bancario, día de negocio ET, control 2026-09-03 →
 *    2026-09-04 ($1608.98) — sólo exigible DESPUÉS del backfill
 *    (`fix/backfill-payment-surcharge.ts`); antes reporta cuántos pagos
 *    siguen en 0 con metadata y no falla la sección. En una base SIN créditos
 *    `MER BNKCD` (el sandbox no tiene feed de Plaid) la sección es informativa:
 *    el control sólo se afirma contra producción (lectura declarada en el plan).
 * §2b tarjetas como candidatas REALES: corre `DEPOSIT_PAYMENT_ELIGIBLE_SQL` +
 *    `DEPOSIT_RECEIPT_SQL` de producción (no la fórmula re-tipeada) y exige que
 *    cash siga siendo elegible.
 * §4 negativo: un pago SIN metadata de surcharge tiene surcharge_cents=0 y
 *    su asiento tiene exactamente 2 líneas.
 *
 * Run: cd backend && yarn medusa exec ./src/scripts/verify/verify-payment-surcharge.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { buildCustomerPaymentLines } from "../../lib/ledger/lines/customer-payment";
import type { LedgerAccount, PaymentSnapshot } from "../../lib/ledger/types";
import { LedgerError } from "../../lib/ledger/types";
import {
  DEPOSIT_PAYMENT_ELIGIBLE_SQL,
  depositReservedSql,
} from "../../lib/banking/payment-evidence";
import { DEPOSIT_RECEIPT_SQL } from "../../lib/banking/deposit-read";

function account(id: string, account_type: string): LedgerAccount {
  return { id, name: id, account_type, currency: "USD", normal_balance: null };
}

export default async function verifyPaymentSurcharge({ container }: ExecArgs) {
  let failures = 0;
  const log = (s = "") => console.log(s);
  const check = (cond: boolean, label: string) => {
    log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond) failures++;
  };

  const undepositedFunds = account("UF-1", "OtherCurrentAsset");
  const accountsReceivable = account("AR-1", "AccountsReceivable");
  const surchargeAccount = account("CCS-1", "Income");
  const map = {
    accounts_receivable: accountsReceivable,
    undeposited_funds: undepositedFunds,
    sales_tax_payable: account("STP", "OtherCurrentLiability"),
    inventory_asset: account("INV", "OtherCurrentAsset"),
    sales_discounts: account("SD", "Income"),
    shipping_income: account("SI", "Income"),
    income_default: account("ID", "Income"),
    cogs_default: account("CD", "CostOfGoodsSold"),
    bad_debt: account("BD", "Expense"),
  };

  log("§1 buildCustomerPaymentLines");
  {
    const snapshot: PaymentSnapshot = {
      type: "payment",
      amountCents: 23281n,
      surchargeCents: 698n,
    };
    const lines = buildCustomerPaymentLines(snapshot, map, surchargeAccount);
    check(lines.length === 3, "surcharge 698 → 3 líneas");
    const debits = lines.reduce((a, l) => a + l.debit_cents, 0n);
    const credits = lines.reduce((a, l) => a + l.credit_cents, 0n);
    check(debits === credits, `balanceado (Dr ${debits} = Cr ${credits})`);
    const surchargeLine = lines.find((l) => l.role === "credit_card_surcharge");
    check(!!surchargeLine && surchargeLine.credit_cents === 698n, "línea de surcharge credita 698");
    check(
      lines.find((l) => l.role === "undeposited_funds")?.debit_cents === 23281n + 698n,
      "undeposited_funds debita amount+surcharge"
    );
    check(
      lines.find((l) => l.role === "accounts_receivable")?.credit_cents === 23281n,
      "accounts_receivable credita SOLO amount (nunca el surcharge)"
    );

    const legacy = buildCustomerPaymentLines(
      { type: "payment", amountCents: 23281n, surchargeCents: 0n },
      map
    );
    check(legacy.length === 2, "surcharge 0 → 2 líneas (legacy)");

    let threw: unknown;
    try {
      buildCustomerPaymentLines({ type: "payment", amountCents: 23281n, surchargeCents: 698n }, map);
    } catch (error) {
      threw = error;
    }
    check(
      threw instanceof LedgerError && threw.code === "GL_ACCOUNT_MAP_MISSING",
      "surcharge > 0 sin surchargeAccount → GL_ACCOUNT_MAP_MISSING"
    );

    const refund = buildCustomerPaymentLines(
      { type: "refund", amountCents: 23281n, surchargeCents: 698n },
      map,
      surchargeAccount
    );
    check(refund.length === 2, "refund con surcharge lo ignora → 2 líneas");
  }

  const knex = container.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[] }>;
  };

  log("");
  log("§2 depositCandidates: available_amount = (amount+surcharge)/100");
  {
    const { rows } = await knex.raw(
      `SELECT mp.id,mp.amount::text,mp.surcharge_cents,
        (mp.amount::numeric/100-${depositReservedSql("NULL::text")})::numeric(30,2)::text AS legacy_basis,
        ((mp.amount::numeric+COALESCE(mp.surcharge_cents,0))/100-${depositReservedSql("NULL::text")})::numeric(30,2)::text AS candidate_basis
       FROM customer_payment mp
       WHERE mp.deleted_at IS NULL AND mp.surcharge_cents > 0
       ORDER BY mp.received_at LIMIT 3`
    );
    if (rows.length === 0) {
      log("  SKIP — no hay pagos con surcharge_cents > 0 todavía (correr el backfill primero)");
    } else {
      for (const row of rows) {
        check(
          row.candidate_basis !== row.legacy_basis,
          `${row.id}: la base del candidato incluye el surcharge (${row.candidate_basis} vs legacy ${row.legacy_basis})`
        );
      }
    }
  }

  log("");
  log("§2b tarjetas como candidatas REALES (predicado y SELECT de producción, no la fórmula re-tipeada)");
  {
    // Delta v2 del plan: las tarjetas entran a Record deposit. Se corre el mismo
    // predicado + SELECT que usa `depositCandidates`, con $2 (deposit_id) = NULL.
    // knex.raw bindea con `?`; el `$2::text` (deposit_id) embebido en el SELECT de
    // producción se sustituye por NULL — mismo valor que usa un depósito nuevo.
    const receiptSql = DEPOSIT_RECEIPT_SQL.split("$2::text").join("NULL::text");
    const { rows } = await knex.raw(
      `SELECT ${receiptSql}, mp.surcharge_cents, mp.amount::text AS amount_cents
         FROM customer_payment mp JOIN customer c ON c.id=mp.customer_id AND c.deleted_at IS NULL
        WHERE ${DEPOSIT_PAYMENT_ELIGIBLE_SQL} AND upper(mp.currency)='USD'
          AND mp.method IN ('credit_card','debit_card') AND mp.surcharge_cents > 0
        ORDER BY mp.received_at DESC LIMIT 3`
    );
    check(rows.length > 0, `al menos una tarjeta con surcharge es candidata de depósito (${rows.length})`);
    for (const row of rows) {
      const expected = ((Number(row.amount_cents) + Number(row.surcharge_cents)) / 100).toFixed(2);
      check(
        Number(row.available_amount) === Number(expected) || Number(row.available_amount) < Number(expected),
        `${row.id}: available ${row.available_amount} ≤ amount+surcharge ${expected} (igual si no está reservado)`
      );
      check(
        Number(row.surcharge_amount) === Number(row.surcharge_cents) / 100,
        `${row.id}: surcharge_amount ${row.surcharge_amount} = surcharge_cents/100`
      );
    }
    const { rows: cash } = await knex.raw(
      `SELECT count(*)::int AS n FROM customer_payment mp WHERE ${DEPOSIT_PAYMENT_ELIGIBLE_SQL} AND mp.method='cash'`
    );
    check(Number(cash[0]?.n ?? 0) > 0, "cash sigue siendo elegible (no se rompió la lista de métodos)");
  }

  log("");
  log("§3 paridad con el feed bancario (día de negocio ET)");
  {
    const { rows: unbackfilled } = await knex.raw(
      `SELECT count(*)::text AS count FROM customer_payment
        WHERE deleted_at IS NULL AND surcharge_cents = 0
          AND (COALESCE((metadata->>'dejavoo_surcharge_cents')::numeric,0) > 0
            OR COALESCE((metadata->>'bams_surcharge_fee_cents')::numeric,0) > 0)`
    );
    const pending = Number(unbackfilled[0]?.count ?? 0);
    if (pending > 0) {
      log(`  surcharge_cents not backfilled yet: ${pending} payments still 0 with metadata`);
    } else {
      const { rows } = await knex.raw(
        `WITH daily AS (
           SELECT batch_day AS day,
             SUM(amount::numeric+COALESCE(surcharge_cents,0))::numeric/100 AS pos_total
           FROM customer_payment
           WHERE deleted_at IS NULL AND type='payment' AND method IN ('credit_card','debit_card')
             AND status<>'voided' AND batch_day >= '2026-04-17'
           GROUP BY batch_day
         ), feed AS (
           SELECT transaction_date::date::text AS day,
             SUM(-amount::numeric) AS feed_total
           FROM bank_transaction
           WHERE deleted_at IS NULL AND amount::numeric < 0
             AND (name ILIKE '%MER BNKCD%' OR name ILIKE '%MERCHANT BANKCD DEPOSIT%')
           GROUP BY 1
         )
         SELECT d.day AS pos_day,
           (d.day::date + CASE WHEN EXTRACT(dow FROM d.day::date) IN (5,6)
             THEN (7-EXTRACT(dow FROM d.day::date)::int)+1 ELSE 1 END)::text AS expected_feed_day,
           d.pos_total::text AS pos_total, f.feed_total::text AS feed_total
         FROM daily d
         LEFT JOIN feed f ON f.day = (d.day::date + CASE WHEN EXTRACT(dow FROM d.day::date) IN (5,6)
           THEN (7-EXTRACT(dow FROM d.day::date)::int)+1 ELSE 1 END)::text
         ORDER BY d.day`
      );
      let exact = 0;
      let near = 0;
      let mismatch = 0;
      let controlOk = false;
      for (const row of rows) {
        const pos = Number(row.pos_total);
        const feed = row.feed_total === null ? null : Number(row.feed_total);
        const delta = feed === null ? Infinity : Math.abs(pos - feed);
        if (delta === 0) exact++;
        else if (delta <= 25) near++;
        else mismatch++;
        if (row.pos_day === "2026-09-03" && row.expected_feed_day === "2026-09-04") {
          controlOk = delta === 0 && Math.abs(pos - 1608.98) < 0.005;
        }
      }
      const feedDays = rows.filter((row) => row.feed_total !== null).length;
      log(`  exact=${exact} near(<=$25)=${near} mismatch=${mismatch} (días con feed: ${feedDays})`);
      if (feedDays === 0) {
        // El sandbox no tiene feed de Plaid: la paridad sólo se puede afirmar
        // contra producción (lectura declarada en el plan). Acá es informativa.
        log("  SKIP — esta base no tiene créditos MER BNKCD (sin feed): el control corre contra prod");
      } else {
        check(controlOk, "control 2026-09-03 → 2026-09-04 es un match exacto de $1608.98");
      }
    }
  }

  log("");
  log("§4 negativo: pago SIN metadata de surcharge");
  {
    const { rows } = await knex.raw(
      `SELECT id, surcharge_cents FROM customer_payment
        WHERE deleted_at IS NULL
          AND COALESCE((metadata->>'dejavoo_surcharge_cents')::numeric,0) = 0
          AND COALESCE((metadata->>'bams_surcharge_fee_cents')::numeric,0) = 0
        ORDER BY received_at DESC LIMIT 1`
    );
    const row = rows[0];
    if (!row) {
      log("  SKIP — no hay pagos sin metadata de surcharge en esta base");
    } else {
      check(Number(row.surcharge_cents) === 0, `${row.id}: surcharge_cents es 0 sin metadata`);
      const { rows: lineCount } = await knex.raw(
        `SELECT count(*)::text AS n FROM bank_journal_line l
           JOIN bank_journal_entry e ON e.id=l.entry_id
          WHERE l.deleted_at IS NULL AND e.source_kind='customer_payment' AND e.source_id=?
            AND e.reverses_entry_id IS NULL`,
        [row.id]
      );
      const n = Number(lineCount[0]?.n ?? 0);
      check(n === 0 || n === 2, `${row.id}: su asiento tiene 2 líneas (o 0 si nunca posteó) — tiene ${n}`);
    }
  }

  log("");
  log(failures === 0 ? "✅ card surcharge gate: todo verde" : `❌ ${failures} check(s) fallaron`);
  if (failures > 0) process.exitCode = 1;
}
