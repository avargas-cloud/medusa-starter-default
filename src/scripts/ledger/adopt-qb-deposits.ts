/**
 * adopt-qb-deposits — los Deposits 2026 de QuickBooks pasan a ser documentos
 * `bank_deposit` del POS (Record Deposits = Make Deposits), ADOPTANDO el
 * TxnID: nunca un DepositAdd nuevo (record-deposits-gl-20260915, fase B).
 *
 * Qué hace por cada `qb_import` de tipo Deposit (asiento activo del libro):
 *  1. Busca su `DepositRet` en la caché (`DepositQueryRq` con líneas, ver
 *     `--cache`). Sin caché no adivina: se saltea con motivo.
 *  2. Arma el `bank_deposit` (status `ready`, `DEP-####` en orden de fecha,
 *     `account_list_id` = `DepositToAccountRef`, cuenta Plaid si existe) y
 *     sus líneas: `DepositLineRet` con TxnID → `customer_payment` por su
 *     TxnID de QB (línea de cobro, snapshot como el picker); lo que no mapea
 *     → línea MANUAL con la cuenta de QB de la línea (AP, Cash Register…;
 *     UF = null) y el nombre de la entidad.
 *  3. RE-PARENTA el asiento: `source_kind='bank_deposit'`, `source_id`,
 *     `document_number`. Mismo `entry_id`, mismas líneas, mismos matches de
 *     extracto — los extractos ene–ago están CERRADOS y nada se re-postea.
 *     `bank_journal_entry_immutable` y `bank_statement_deposit_line_guard`
 *     rechazan exactamente eso, por diseño: se DESHABILITAN dentro de la
 *     transacción del lote y el propio COMMIT/ROLLBACK los devuelve. Es el
 *     único lugar del repo que lo hace; el E2E lo prueba con y sin el bypass.
 *  4. Estampa `qb_txn_id`/`qb_txn_type`/`qb_edit_sequence`/`qb_synced_at` y
 *     un `bank_review_event` con `origin: 'qb_adopted'` y el estado anterior
 *     (lo que `--revert` deshace).
 *
 * Idempotente por TxnID (`bank_deposit.qb_txn_id`). Dry-run por default:
 * imprime el plan y los motivos de skip. `--apply` escribe en lotes de
 * `--batch` (default 50), cada lote en UNA transacción con `lock_timeout`.
 *
 * Una línea NEGATIVA (ARRefundCreditCard neteado en el lote de tarjetas) va
 * como línea manual negativa contra UF. Fuera de alcance (se saltean con
 * motivo): depósitos con total ≤ 0 (reversas hechas como Deposit), sin cuenta
 * destino activa en `qb_account`, o cuyo asiento no coincide con QB en total.
 *
 *   env DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/ledger/adopt-qb-deposits.ts \
 *     --cache .qb-docs-cache [--from 2026-01-01 --to 2026-09-30] [--txn <TxnID>] [--apply --batch 50]
 *   … --revert --txn <TxnID> --apply        # deshace UNA adopción
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { depositMajor } from "../../lib/banking/deposit-types";
import { PAYMENT_FINGERPRINT_SQL } from "../../lib/banking/payment-evidence";
import { bankId } from "../../lib/banking/store";
import { allocateGlNumber } from "../../lib/ledger/documents/manual-shared";

const ACTOR = "adopt-qb-deposits";
const UF_LIST_ID_KEY = "undeposited_funds";

type Args = { cache: string; from: string; to: string; txn: string | null; apply: boolean; batch: number; revert: boolean };
function parseArgs(argv: string[]): Args {
  const one = (flag: string): string | null => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []))[0] ?? null;
  const day = (v: string | null, d: string): string => {
    if (!v) return d;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`fecha inválida: ${v}`);
    return v;
  };
  return {
    cache: one("--cache") ?? ".qb-docs-cache",
    from: day(one("--from"), "2026-01-01"),
    to: day(one("--to"), "2026-12-31"),
    txn: one("--txn"),
    apply: argv.includes("--apply"),
    batch: Math.max(1, Math.min(200, Number(one("--batch") ?? 50))),
    revert: argv.includes("--revert"),
  };
}

// ── caché de DepositQueryRs ──────────────────────────────────────────────────
type Ref = { ListID?: string; FullName?: string };
type DepositLineRet = { TxnType?: string; TxnID?: string; TxnLineID?: string; EntityRef?: Ref; AccountRef?: Ref; Memo?: string; Amount?: string; PaymentMethodRef?: Ref };
type DepositRet = {
  TxnID: string; EditSequence?: string; TxnDate: string; TimeModified?: string; Memo?: string; DepositTotal: string;
  DepositToAccountRef?: Ref; DepositLineRet?: DepositLineRet | DepositLineRet[]; CashBackInfoRet?: unknown;
};
function loadCache(dir: string): Map<string, DepositRet> {
  const out = new Map<string, DepositRet>();
  for (const file of readdirSync(dir).filter((f) => /^deposits-\d{4}-\d{2}\.json$/.test(f)).sort()) {
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as { DepositQueryRs?: { DepositRet?: DepositRet | DepositRet[] } };
    const rets = raw.DepositQueryRs?.DepositRet;
    for (const r of Array.isArray(rets) ? rets : rets ? [rets] : []) out.set(r.TxnID, r);
  }
  return out;
}
const linesOf = (r: DepositRet): DepositLineRet[] => (Array.isArray(r.DepositLineRet) ? r.DepositLineRet : r.DepositLineRet ? [r.DepositLineRet] : []);
const cents = (major: string | undefined): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec((major ?? "0").trim());
  if (!m) throw new Error(`monto QB ilegible: ${major}`);
  const c = BigInt(m[2]!) * 100n + BigInt((m[3] ?? "").padEnd(2, "0"));
  return m[1] === "-" ? -c : c;
};
const money = (c: bigint): string => `$${(Number(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

// ── plan por depósito ───────────────────────────────────────────────────────
type EntryRow = { id: string; day: string; txn_id: string; amount_cents: string; document_number: string | null };
type PaymentRow = { id: string; display_id: number | null; customer_id: string; customer_name: string; method: string; amount: string; surcharge_amount: string; card_brand: string | null; source_hash: string; received: string };
type PlannedLine =
  | { kind: "payment"; payment: PaymentRow; cents: bigint; qb: DepositLineRet }
  | { kind: "manual"; reference: string; description: string; account_list_id: string | null; cents: bigint; qb: DepositLineRet };
type Plan = { entry: EntryRow; ret: DepositRet; target: string; account_id: string | null; lines: PlannedLine[]; gross: bigint };
type Skip = { entry: EntryRow; reason: string };

async function planOne(client: PoolClient, entry: EntryRow, ret: DepositRet | undefined, uf: string): Promise<Plan | Skip> {
  if (!ret) return { entry, reason: "not_in_qb_cache (borrado en QB o fuera de la caché)" };
  const target = ret.DepositToAccountRef?.ListID;
  if (!target) return { entry, reason: "no DepositToAccountRef" };
  const acct = (await client.query<{ t: string }>(`SELECT account_type AS t FROM qb_account WHERE qb_list_id=$1 AND is_active AND deleted_at IS NULL`, [target])).rows[0];
  if (!acct) return { entry, reason: `target_not_active: ${ret.DepositToAccountRef?.FullName}` };
  if (ret.CashBackInfoRet) return { entry, reason: "cash_back_line (no modelado)" };
  const qbLines = linesOf(ret);
  if (!qbLines.length) return { entry, reason: "no lines" };
  const total = cents(ret.DepositTotal);
  if (total <= 0n) return { entry, reason: "non_positive_total (reversa hecha como Deposit)" };
  if (qbLines.some((l) => cents(l.Amount) === 0n)) return { entry, reason: "zero_line" };
  // El asiento importado debita la cuenta destino por el DepositTotal (neto de
  // líneas negativas); `amount_cents` del asiento es Σ débitos, que incluye
  // los débitos a UF de los refunds — por eso se compara la línea del banco.
  const bank = (await client.query<{ c: string }>(
    `SELECT COALESCE(SUM(l.debit_cents),0)::text AS c FROM bank_journal_line l WHERE l.entry_id=$1 AND l.account_list_id=$2`, [entry.id, target]
  )).rows[0]!.c;
  if (BigInt(bank) !== total) return { entry, reason: `ledger_total_mismatch bank_line=${bank} qb=${total}` };
  const account_id = (await client.query<{ id: string }>(`SELECT id FROM bank_account WHERE qb_list_id=$1 AND deleted_at IS NULL ORDER BY is_selected DESC LIMIT 1`, [target])).rows[0]?.id ?? null;

  const lines: PlannedLine[] = [];
  const seenPayments = new Set<string>();
  for (const l of qbLines) {
    const c = cents(l.Amount);
    const payment = l.TxnID
      ? (await client.query<PaymentRow>(
          `SELECT mp.id,mp.display_id,mp.customer_id,
            COALESCE(NULLIF(c.company_name,''),NULLIF(trim(concat_ws(' ',c.first_name,c.last_name)),''),c.email,c.id) AS customer_name,
            mp.method,mp.card_brand,(mp.amount::numeric/100)::numeric(30,2)::text AS amount,
            (COALESCE(mp.surcharge_cents,0)::numeric/100)::numeric(30,2)::text AS surcharge_amount,
            ${PAYMENT_FINGERPRINT_SQL} AS source_hash,to_char(mp.received_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS received
           FROM customer_payment mp LEFT JOIN customer c ON c.id=mp.customer_id
           WHERE mp.deleted_at IS NULL AND COALESCE(mp.qb->>'txn_id',mp.metadata->>'qb_txn_id')=$1 LIMIT 1`,
          [l.TxnID]
        )).rows[0]
      : undefined;
    if (payment && c > 0n && !seenPayments.has(payment.id) && (l.AccountRef?.ListID ?? uf) === uf) {
      seenPayments.add(payment.id);
      lines.push({ kind: "payment", payment, cents: c, qb: l });
      continue;
    }
    const accountListId = l.AccountRef?.ListID && l.AccountRef.ListID !== uf ? l.AccountRef.ListID : null;
    const entity = l.EntityRef?.FullName?.trim();
    const reference = l.TxnID ? `QB ${l.TxnType ?? "Txn"} ${l.TxnID}` : `QB ${ret.TxnID}:${l.TxnLineID ?? lines.length + 1}`;
    const description = [entity, l.Memo?.trim(), accountListId ? l.AccountRef?.FullName : null].filter(Boolean).join(" · ");
    lines.push({ kind: "manual", reference, description, account_list_id: accountListId, cents: c, qb: l });
  }
  const gross = lines.reduce((s, l) => s + l.cents, 0n);
  if (gross !== total) return { entry, reason: `lines_total_mismatch lines=${gross} qb=${total}` };
  return { entry, ret, target, account_id, lines, gross };
}

// ── escritura de UN depósito (dentro de la tx del lote) ─────────────────────
async function adoptOne(client: PoolClient, p: Plan): Promise<string> {
  const id = bankId("bdep");
  const number = await allocateGlNumber(client, "bank_deposit", "DEP");
  const gross = depositMajor(p.gross);
  await client.query(
    `INSERT INTO bank_deposit (id,revision,status,account_id,account_list_id,currency,deposit_date,reference,memo,gross_amount,fee_amount,
       fee_account_list_id,fee_reference,fee_account_snapshot,net_amount,created_by,ready_by,ready_at,number,qb_txn_id,qb_txn_type,qb_edit_sequence,qb_synced_at)
     VALUES ($1,1,'ready',$2,$3,'USD',$4,'',$5,$6,'0.00',NULL,NULL,NULL,$6,$7,$7,now(),$8,$9,'Deposit',$10,COALESCE($11::timestamptz,now()))`,
    [id, p.account_id, p.target, p.entry.day, (p.ret.Memo ?? "").trim(), gross, ACTOR, number, p.ret.TxnID, p.ret.EditSequence ?? null, p.ret.TimeModified ?? null]
  );
  for (const l of p.lines) {
    if (l.kind === "payment") {
      const snap = {
        fingerprint_version: 2, id: l.payment.id, display_id: l.payment.display_id, customer_id: l.payment.customer_id,
        customer_name: l.payment.customer_name, method: l.payment.method, amount: l.payment.amount,
        surcharge_amount: l.payment.surcharge_amount, card_brand: l.payment.card_brand, date: l.payment.received,
        adopted_from_qb: { txn_type: l.qb.TxnType, txn_id: l.qb.TxnID },
      };
      await client.query(
        `INSERT INTO bank_deposit_line (id,deposit_id,payment_id,amount,source_hash,payment_snapshot) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [bankId("bdl"), id, l.payment.id, depositMajor(l.cents), l.payment.source_hash, JSON.stringify(snap)]
      );
    } else {
      const snap = { manual: true, reference: l.reference, description: l.description, amount: depositMajor(l.cents), account_list_id: l.account_list_id, adopted_from_qb: l.qb };
      await client.query(
        `INSERT INTO bank_deposit_line (id,deposit_id,payment_id,amount,source_hash,payment_snapshot,manual_reference,manual_description,manual_account_list_id)
         VALUES ($1,$2,NULL,$3,md5($4::text),$4::jsonb,$5,$6,$7)`,
        [bankId("bdl"), id, depositMajor(l.cents), JSON.stringify(snap), l.reference, l.description || null, l.account_list_id]
      );
    }
  }
  const upd = await client.query(
    `UPDATE bank_journal_entry SET source_kind='bank_deposit', source_id=$2, document_number=$3, updated_at=now()
      WHERE id=$1 AND source_kind='qb_import' AND source_id=$4 AND kind='document'`,
    [p.entry.id, id, number, p.ret.TxnID]
  );
  if (upd.rowCount !== 1) throw new Error(`re-parent falló para ${p.entry.id} (${p.ret.TxnID})`);
  await client.query(
    `INSERT INTO bank_review_event (id,entity_type,entity_id,transaction_id,action,actor_id,details) VALUES ($1,'deposit',$2,NULL,'deposit_saved',$3,$4::jsonb)`,
    [bankId("bre"), id, ACTOR, JSON.stringify({ origin: "qb_adopted", qb_txn_id: p.ret.TxnID, entry_id: p.entry.id, previous: { source_kind: "qb_import", source_id: p.ret.TxnID, document_number: p.entry.document_number }, number })]
  );
  return number;
}

async function revertOne(client: PoolClient, txn: string): Promise<void> {
  // El asiento y su número original salen del propio asiento (el snapshot de
  // qb_import sigue intacto), no del bank_review_event: un cleanup ajeno puede
  // haberlo borrado y el revert tiene que seguir funcionando.
  const dep = (await client.query<{ id: string; entry_id: string; previous_number: string }>(
    `SELECT d.id, e.id AS entry_id,
            left(e.source_snapshot->>'txn_type'||' '||COALESCE(e.source_snapshot->>'ref_number', e.source_snapshot->>'txn_id'), 80) AS previous_number
       FROM bank_deposit d JOIN bank_journal_entry e ON e.source_kind='bank_deposit' AND e.source_id=d.id AND e.kind='document'
      WHERE d.qb_txn_id=$1 AND d.created_by=$2 AND d.deleted_at IS NULL AND e.source_snapshot->>'txn_id'=$1 LIMIT 1`, [txn, ACTOR]
  )).rows[0];
  if (!dep) throw new Error(`no hay depósito adoptado con TxnID ${txn}`);
  const upd = await client.query(
    `UPDATE bank_journal_entry SET source_kind='qb_import', source_id=$2, document_number=$3, updated_at=now() WHERE id=$1 AND source_kind='bank_deposit' AND source_id=$4`,
    [dep.entry_id, txn, dep.previous_number, dep.id]
  );
  if (upd.rowCount !== 1) throw new Error(`revert: el asiento ${dep.entry_id} no está parentado a ${dep.id}`);
  await client.query(`DELETE FROM bank_review_event WHERE entity_type='deposit' AND entity_id=$1`, [dep.id]);
  await client.query(`DELETE FROM bank_deposit_line WHERE deposit_id=$1`, [dep.id]);
  await client.query(`DELETE FROM bank_deposit WHERE id=$1`, [dep.id]);
  console.log(`revertido ${dep.id} → qb_import ${txn} (asiento ${dep.entry_id})`);
}

/** Los dos guards que rechazan la adopción por diseño, apagados SÓLO dentro de esta transacción. */
async function withAdoptionBypass<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`ALTER TABLE bank_journal_entry DISABLE TRIGGER bank_journal_entry_immutable`);
    await client.query(`ALTER TABLE bank_deposit_line DISABLE TRIGGER bank_statement_deposit_line_guard`);
    const out = await fn();
    await client.query(`ALTER TABLE bank_deposit_line ENABLE TRIGGER bank_statement_deposit_line_guard`);
    await client.query(`ALTER TABLE bank_journal_entry ENABLE TRIGGER bank_journal_entry_immutable`);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client = await getDbPool().connect();
  try {
    if (args.revert) {
      if (!args.txn) throw new Error("--revert exige --txn");
      if (!args.apply) { console.log(`dry-run: revertiría la adopción de ${args.txn}`); return; }
      await withAdoptionBypass(client, () => revertOne(client, args.txn!));
      return;
    }
    const uf = (await client.query<{ id: string }>(`SELECT qb_list_id AS id FROM gl_account_map WHERE key=$1`, [UF_LIST_ID_KEY])).rows[0]?.id;
    if (!uf) throw new Error("gl_account_map sin undeposited_funds");
    const cache = loadCache(args.cache);
    console.log(`caché: ${cache.size} DepositRet en ${args.cache}`);
    const entries = (await client.query<EntryRow>(
      `SELECT e.id, e.day, e.source_id AS txn_id, e.amount_cents::text, e.document_number
         FROM bank_journal_entry e
        WHERE e.source_kind='qb_import' AND e.kind='document' AND e.deleted_at IS NULL AND e.source_snapshot->>'txn_type'='Deposit'
          AND e.day BETWEEN $1 AND $2 AND ($3::text IS NULL OR e.source_id=$3)
          AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)
          AND NOT EXISTS (SELECT 1 FROM bank_deposit d WHERE d.qb_txn_id=e.source_id AND d.deleted_at IS NULL)
        ORDER BY e.day, e.created_at, e.id`,
      [args.from, args.to, args.txn]
    )).rows;
    const already = (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM bank_deposit WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL AND created_by=$1`, [ACTOR])).rows[0]!.n;
    console.log(`candidatos qb_import Deposit ${args.from}→${args.to}: ${entries.length} (ya adoptados antes: ${already})`);

    const plans: Plan[] = [], skips: Skip[] = [];
    for (const entry of entries) {
      const r = await planOne(client, entry, cache.get(entry.txn_id), uf);
      if ("reason" in r) skips.push(r); else plans.push(r);
    }
    const byTarget = new Map<string, { n: number; cents: bigint }>();
    let paymentLines = 0, manualLines = 0, manualUf = 0;
    for (const p of plans) {
      const t = p.ret.DepositToAccountRef?.FullName ?? p.target;
      const cur = byTarget.get(t) ?? { n: 0, cents: 0n };
      byTarget.set(t, { n: cur.n + 1, cents: cur.cents + p.gross });
      for (const l of p.lines) { if (l.kind === "payment") paymentLines++; else { manualLines++; if (!l.account_list_id) manualUf++; } }
    }
    console.log(`\nplan: ${plans.length} depósitos adoptables · ${skips.length} salteados`);
    for (const [t, v] of [...byTarget].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${t.padEnd(32)} ${String(v.n).padStart(4)}  ${money(v.cents)}`);
    console.log(`  líneas: ${paymentLines} de cobros del POS · ${manualLines} manuales (${manualUf} contra UF sin cobro, ${manualLines - manualUf} contra otra cuenta)`);
    const reasons = new Map<string, number>();
    for (const s of skips) reasons.set(s.reason.split(" ")[0]!, (reasons.get(s.reason.split(" ")[0]!) ?? 0) + 1);
    for (const [r, n] of reasons) console.log(`  skip ${r}: ${n}`);
    for (const s of skips) console.log(`    - ${s.entry.day} ${s.entry.txn_id} ${money(BigInt(s.entry.amount_cents))} → ${s.reason}`);
    if (!args.apply) { console.log("\n(dry-run: nada escrito; --apply para adoptar por lotes)"); return; }

    let done = 0;
    for (let i = 0; i < plans.length; i += args.batch) {
      const batch = plans.slice(i, i + args.batch);
      const numbers = await withAdoptionBypass(client, async () => {
        const out: string[] = [];
        for (const p of batch) out.push(await adoptOne(client, p));
        // Nada del lote movió el libro: mismas líneas, mismos matches.
        const check = (await client.query<{ lines_ok: boolean; parented: string }>(
          `SELECT bool_and((SELECT count(*) FROM bank_journal_line l WHERE l.entry_id=e.id)>0) AS lines_ok,
                  count(*) FILTER (WHERE e.source_kind='bank_deposit')::text AS parented
             FROM bank_journal_entry e WHERE e.id = ANY($1::text[])`, [batch.map((p) => p.entry.id)]
        )).rows[0]!;
        if (!check.lines_ok || Number(check.parented) !== batch.length) throw new Error(`verificación del lote falló: ${JSON.stringify(check)}`);
        return out;
      });
      done += numbers.length;
      console.log(`lote ${Math.floor(i / args.batch) + 1}: ${numbers[0]}…${numbers[numbers.length - 1]} (${done}/${plans.length})`);
    }
    console.log(`\nadoptados ${done} depósitos; salteados ${skips.length}`);
  } finally {
    client.release();
    await getDbPool().end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
