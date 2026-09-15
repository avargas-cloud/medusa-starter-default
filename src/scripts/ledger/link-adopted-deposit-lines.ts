/**
 * link-adopted-deposit-lines — un cobro del POS que QuickBooks depositó bajo
 * OTRO documento (un pago creado a mano en QB, memo "POS Invoice …") quedó en
 * la adopción como línea MANUAL contra UF, y el cobro del POS sigue
 * "disponible" en Record Deposits aunque el banco ya lo recibió
 * (record-deposits-gl-20260915 v3). Este script enlaza la línea manual con
 * el cobro: mismo asiento, mismo monto, sólo cambia quién consume la línea.
 *
 * Regla de casamiento (falla cerrado): línea manual contra UF (sin cuenta),
 * de un depósito adoptado fechado entre el día del cobro y +21, con el MISMO
 * monto que el cobro (sin surcharge, que QB no tenía) y la descripción
 * conteniendo el nombre del cliente; exactamente UN candidato. Lo que no
 * casa se lista con motivo y no se toca.
 *
 * Dry-run por default; `--apply` escribe en UNA transacción con
 * `bank_statement_deposit_line_guard` apagado (los extractos están cerrados;
 * el libro no se mueve — ninguna línea de journal cambia).
 *
 *   env DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/ledger/link-adopted-deposit-lines.ts [--from 2026-04-14 --to 2026-09-13] [--pair 3524=DEP-0607] [--apply]
 */
import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { PAYMENT_FINGERPRINT_SQL } from "../../lib/banking/payment-evidence";
import { bankId } from "../../lib/banking/store";

const ACTOR = "link-adopted-deposit-lines";
type Orphan = { id: string; display_id: number; day: string; method: string; cents: string; customer_id: string; customer_name: string; amount: string; surcharge_amount: string; card_brand: string | null; source_hash: string };
type Line = { line_id: string; number: string; deposit_date: string; descr: string | null };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const one = (f: string): string | null => argv.flatMap((a, i) => (a === f && argv[i + 1] ? [argv[i + 1]!] : []))[0] ?? null;
  const from = one("--from") ?? "2026-04-14", to = one("--to") ?? "2026-09-13", apply = argv.includes("--apply");
  // --pair <display_id>=<DEP-####>: el operador afirma el depósito cuando el nombre no
  // coincide (p. ej. el cliente cambió de nombre); sigue exigiendo monto exacto y línea única.
  const pairs = new Map(argv.flatMap((a, i) => (a === "--pair" && argv[i + 1] ? [argv[i + 1]!.split("=") as [string, string]] : [])));
  const client: PoolClient = await getDbPool().connect();
  try {
    const orphans = (await client.query<Orphan>(
      `SELECT mp.id, mp.display_id, to_char(mp.received_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS day, mp.method, mp.amount::text AS cents,
              mp.customer_id, COALESCE(NULLIF(c.company_name,''),NULLIF(trim(concat_ws(' ',c.first_name,c.last_name)),''),c.email,c.id) AS customer_name,
              (mp.amount::numeric/100)::numeric(30,2)::text AS amount, (COALESCE(mp.surcharge_cents,0)::numeric/100)::numeric(30,2)::text AS surcharge_amount,
              mp.card_brand, ${PAYMENT_FINGERPRINT_SQL} AS source_hash
         FROM customer_payment mp JOIN customer c ON c.id=mp.customer_id
        WHERE mp.deleted_at IS NULL AND mp.type='payment' AND mp.method IN ('cash','ach','zelle','check','credit_card','debit_card','card')
          AND mp.status IN ('available','partially_applied','applied') AND mp.amount::numeric>0 AND COALESCE(mp.metadata->>'qb_import','false')='false'
          AND (mp.received_at AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
          AND NOT EXISTS (SELECT 1 FROM bank_deposit_line dl JOIN bank_deposit d ON d.id=dl.deposit_id WHERE dl.payment_id=mp.id AND dl.deleted_at IS NULL AND d.deleted_at IS NULL AND d.status<>'void')
        ORDER BY mp.received_at`, [from, to]
    )).rows;
    console.log(`cobros huérfanos ${from}→${to}: ${orphans.length}`);
    const plan: Array<{ o: Orphan; l: Line }> = [], skip: Array<{ o: Orphan; reason: string }> = [];
    for (const o of orphans) {
      const forced = pairs.get(String(o.display_id)) ?? null;
      const key = forced ? "" : o.customer_name.trim().slice(0, 12).toLowerCase();
      const lines = (await client.query<Line>(
        `SELECT dl.id AS line_id, d.number, d.deposit_date, dl.manual_description AS descr
           FROM bank_deposit_line dl JOIN bank_deposit d ON d.id=dl.deposit_id
          WHERE d.created_by='adopt-qb-deposits' AND d.deleted_at IS NULL AND d.status='ready' AND dl.deleted_at IS NULL
            AND dl.manual_reference IS NOT NULL AND dl.manual_account_list_id IS NULL AND dl.payment_id IS NULL
            AND dl.amount::numeric*100 = $1::numeric AND d.deposit_date::date BETWEEN $2::date AND $2::date + 21
            AND lower(COALESCE(dl.manual_description,'')) LIKE '%'||$3||'%' AND ($4::text IS NULL OR d.number=$4)`, [o.cents, o.day, key, forced]
      )).rows;
      if (lines.length === 1) plan.push({ o, l: lines[0]! });
      else skip.push({ o, reason: lines.length === 0 ? "sin línea manual (cliente+monto+21d)" : `${lines.length} candidatas` });
    }
    for (const p of plan) console.log(`  ✓ #${p.o.display_id} ${p.o.day} ${p.o.method} $${p.o.amount} ${p.o.customer_name} → ${p.l.number} ${p.l.deposit_date} «${(p.l.descr ?? "").slice(0, 40)}»`);
    for (const s of skip) console.log(`  · #${s.o.display_id} ${s.o.day} ${s.o.method} $${s.o.amount} ${s.o.customer_name} → ${s.reason}`);
    console.log(`\n${plan.length} para enlazar · ${skip.length} quedan disponibles`);
    if (!apply) { console.log("(dry-run: nada escrito; --apply para enlazar)"); return; }

    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`ALTER TABLE bank_deposit_line DISABLE TRIGGER bank_statement_deposit_line_guard`);
      for (const { o, l } of plan) {
        const snap = { fingerprint_version: 2, id: o.id, display_id: o.display_id, customer_id: o.customer_id, customer_name: o.customer_name, method: o.method,
          amount: o.amount, surcharge_amount: o.surcharge_amount, card_brand: o.card_brand, date: o.day, linked_by: ACTOR };
        const upd = await client.query(
          `UPDATE bank_deposit_line SET payment_id=$2, manual_reference=NULL, manual_description=NULL, payment_snapshot=$3::jsonb, source_hash=$4, updated_at=now()
            WHERE id=$1 AND payment_id IS NULL AND manual_reference IS NOT NULL`, [l.line_id, o.id, JSON.stringify(snap), o.source_hash]
        );
        if (upd.rowCount !== 1) throw new Error(`no se pudo enlazar ${l.line_id} ← #${o.display_id}`);
        await client.query(
          `INSERT INTO bank_review_event (id,entity_type,entity_id,transaction_id,action,actor_id,details) SELECT $1,'deposit',dl.deposit_id,NULL,'deposit_line_linked',$2,$3::jsonb FROM bank_deposit_line dl WHERE dl.id=$4`,
          [bankId("bre"), ACTOR, JSON.stringify({ line_id: l.line_id, payment_id: o.id, display_id: o.display_id }), l.line_id]
        );
      }
      await client.query(`ALTER TABLE bank_deposit_line ENABLE TRIGGER bank_statement_deposit_line_guard`);
      await client.query("COMMIT");
      console.log(`enlazados ${plan.length}`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    client.release();
    await getDbPool().end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
