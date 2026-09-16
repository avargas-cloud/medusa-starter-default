/**
 * merge-surcharge-deposits — septiembre al formato nuevo, por lote
 * (deposit-surcharge-qb-20260915 F8).
 *
 * Antes (modelo del operador): por cada lote de tarjetas, DOS Deposits en QB —
 * el del lote (líneas PaymentTxnID, montos SIN surcharge) y otro "BAMS ·
 * Surcharges Fee (3.00%)" contra Accounts Payable por el surcharge. Adoptados
 * al POS como DEP-#### separados.
 *
 * Después (modelo nuevo): UN Deposit por lote = crédito del banco: las mismas
 * líneas PaymentTxnID + una línea `Credit Card Surcharge` (income) por Σ
 * surcharge. El de BAMS desaparece; AP no debe nada al procesador.
 *
 * Por par (lote + BAMS del mismo día y mismo Σ surcharge), con `--apply`:
 *  1. QB `DepositModRq` del lote: TODAS sus líneas (TxnLineID) + la línea
 *     nueva (TxnLineID -1, cuenta income, Σ surcharge) → readback
 *     `DepositQuery`: total = anterior + surcharge, línea presente. Si el
 *     readback no coincide, se DETIENE antes de tocar nada más.
 *  2. QB `TxnDelRq` del Deposit BAMS → readback: ya no existe.
 *  3. POS (una transacción): el DEP de BAMS se anula (reversa del asiento,
 *     sin nada a QB — el TxnDel ya se verificó); el DEP del lote se re-postea
 *     con líneas BRUTAS (amount + surcharge, snapshot actualizado), mismo
 *     TxnID adoptado, EditSequence del readback. Los asientos viven en
 *     septiembre (borrador abierto): la reversa y el posteo nuevo caen el
 *     mismo día. Después hay que regenerar el borrador de Chase
 *     (`reconcile-feed-statement --reset`), que apuntaba a las líneas viejas.
 *
 * Dry-run por default. Idempotente: un lote cuyo Deposit en QB ya tiene la
 * línea de surcharge se saltea; un BAMS ya borrado en QB sólo se anula en el POS.
 *
 *   env DATABASE_URL=… QB_BRIDGE_URL=… QB_API_KEY=… DISABLE_SCHEDULED_JOBS=true ./node_modules/.bin/tsx \
 *     src/scripts/ledger/merge-surcharge-deposits.ts --from 2026-09-01 --to 2026-09-15 [--only DEP-0652] [--apply]
 */
import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { depositMajor } from "../../lib/banking/deposit-types";
import { bankId } from "../../lib/banking/store";
import { postBankDepositDocument, resolveBankDeposit, reverseBankDepositDocument } from "../../lib/ledger/documents/bank-deposit";
import { escapeXml } from "../../lib/quickbooks/qbxml-escape";
import { cents, compareDeposit, loadPosDeposit, qbDirect, readDeposit, rsStatus, type QbDeposit } from "../verify/verify-qb-deposit-readback";

const ACTOR = "merge-surcharge-deposits";

/**
 * MERGE_QB_STUB=1 (sólo sandbox :5499): QuickBooks simulado desde la caché de
 * DepositQuery (`.qb-docs-cache`), para ensayar la transacción del POS y el
 * readback sin tocar el QuickBooks real. El DepositMod "aplica" la línea en
 * memoria; el TxnDel "borra" en memoria.
 */
const STUB = process.env.MERGE_QB_STUB === "1";
const stubState = new Map<string, QbDeposit | null>();
function stubLoad(txnId: string): QbDeposit | null {
  if (stubState.has(txnId)) return stubState.get(txnId)!;
  const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const dir = process.env.E2E_QB_CACHE ?? ".qb-docs-cache";
  for (const f of readdirSync(dir).filter((x) => /^deposits-\d{4}-\d{2}\.json$/.test(x))) {
    const raw = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
    const rets = raw?.DepositQueryRs?.DepositRet; const list = Array.isArray(rets) ? rets : rets ? [rets] : [];
    for (const r of list) if (r.TxnID === txnId) { const d: QbDeposit = { TxnID: r.TxnID, EditSequence: r.EditSequence, TxnDate: r.TxnDate, DepositTotal: r.DepositTotal, Memo: r.Memo, DepositToAccountRef: r.DepositToAccountRef, lines: Array.isArray(r.DepositLineRet) ? r.DepositLineRet : r.DepositLineRet ? [r.DepositLineRet] : [] }; stubState.set(txnId, d); return d; }
  }
  stubState.set(txnId, null); return null;
}
const qb = {
  async read(txnId: string): Promise<QbDeposit | null> { return STUB ? stubLoad(txnId) : readDeposit(txnId); },
  async mod(xml: string, key: string, txnId: string, account: string, amount: bigint, memo: string): Promise<void> {
    if (!STUB) { const rs = (await qbDirect(xml, key)).DepositModRs; const st = rsStatus(rs); if (st.code !== "0") throw new Error(`DepositMod rechazado ${st.code} ${st.message}`); return; }
    const d = stubLoad(txnId); if (!d) throw new Error("stub: no existe");
    stubState.set(txnId, { ...d, EditSequence: String(Number(d.EditSequence) + 1), DepositTotal: major(cents(d.DepositTotal) + amount), lines: [...d.lines, { TxnLineID: "stub-new", AccountRef: { ListID: account }, Amount: major(amount), Memo: memo }] });
  },
  async del(txnId: string, key: string): Promise<void> {
    if (!STUB) { const rs = (await qbDirect(`<TxnDelRq><TxnDelType>Deposit</TxnDelType><TxnID>${txnId}</TxnID></TxnDelRq>`, key)).TxnDelRs; const st = rsStatus(rs); if (st.code !== "0") throw new Error(`TxnDel rechazado ${st.code} ${st.message}`); return; }
    stubState.set(txnId, null);
  },
};

type Batch = { id: string; number: string; day: string; qb_txn_id: string; account_list_id: string; gross: string; surcharge_cents: bigint; lines: number };
type Bams = { id: string; number: string; day: string; qb_txn_id: string; cents: bigint; account: string };

const major = (c: bigint): string => (Number(c) / 100).toFixed(2);

async function loadPairs(client: PoolClient, from: string, to: string, only: string | null): Promise<Array<{ batch: Batch; bams: Bams | null }>> {
  const batches = (await client.query<Batch & { surcharge_cents: string }>(
    `SELECT d.id, d.number, d.deposit_date AS day, d.qb_txn_id, d.account_list_id, d.gross_amount AS gross,
            COALESCE((SELECT SUM(COALESCE(cp.surcharge_cents,0)) FROM bank_deposit_line dl JOIN customer_payment cp ON cp.id=dl.payment_id WHERE dl.deposit_id=d.id AND dl.deleted_at IS NULL),0)::text AS surcharge_cents,
            (SELECT count(*)::int FROM bank_deposit_line dl WHERE dl.deposit_id=d.id AND dl.deleted_at IS NULL) AS lines
       FROM bank_deposit d
      WHERE d.deleted_at IS NULL AND d.status='ready' AND d.qb_txn_id IS NOT NULL AND d.created_by='adopt-qb-deposits'
        AND d.deposit_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR d.number=$3)
        AND EXISTS (SELECT 1 FROM bank_deposit_line dl JOIN customer_payment cp ON cp.id=dl.payment_id WHERE dl.deposit_id=d.id AND dl.deleted_at IS NULL AND cp.method IN ('credit_card','debit_card','card'))
      ORDER BY d.deposit_date, d.number`, [from, to, only]
  )).rows.map((b) => ({ ...b, surcharge_cents: BigInt(b.surcharge_cents) }));
  const out: Array<{ batch: Batch; bams: Bams | null }> = [];
  for (const batch of batches) {
    if (batch.surcharge_cents <= 0n) continue;
    const bams = (await client.query<Bams & { cents: string }>(
      `SELECT d.id, d.number, d.deposit_date AS day, d.qb_txn_id, (dl.amount::numeric*100)::bigint::text AS cents, dl.manual_account_list_id AS account
         FROM bank_deposit d JOIN bank_deposit_line dl ON dl.deposit_id=d.id AND dl.deleted_at IS NULL
        WHERE d.deleted_at IS NULL AND d.status='ready' AND d.deposit_date=$1 AND d.account_list_id=$2 AND d.id<>$3
          AND dl.manual_reference IS NOT NULL AND dl.manual_description ILIKE '%Surcharges Fee%'
          AND (dl.amount::numeric*100)::bigint = $4::bigint LIMIT 1`, [batch.day, batch.account_list_id, batch.id, batch.surcharge_cents.toString()]
    )).rows[0];
    out.push({ batch, bams: bams ? { ...bams, cents: BigInt(bams.cents) } : null });
  }
  return out;
}

function depositModXml(qb: QbDeposit, surchargeAccount: string, surchargeCents: bigint, memo: string): string {
  const lines = qb.lines.map((l) => {
    // Una línea de cobro ya depositada se conserva SOLO por TxnLineID: re-mandar su
    // PaymentTxnID hace que QB la busque en "Payments to Deposit" y rechace con 3210
    // (probado en prod 09/15/2026 sobre 1CEEA0; nada cambió, readback intacto).
    if (l.TxnID) return `<DepositLineMod><TxnLineID>${l.TxnLineID}</TxnLineID></DepositLineMod>`;
    return `<DepositLineMod><TxnLineID>${l.TxnLineID}</TxnLineID>${l.EntityRef?.ListID ? `<EntityRef><ListID>${l.EntityRef.ListID}</ListID></EntityRef>` : ""}<AccountRef><ListID>${l.AccountRef?.ListID}</ListID></AccountRef>${l.Memo ? `<Memo>${escapeXml(l.Memo)}</Memo>` : ""}<Amount>${l.Amount}</Amount></DepositLineMod>`;
  });
  lines.push(`<DepositLineMod><TxnLineID>-1</TxnLineID><AccountRef><ListID>${surchargeAccount}</ListID></AccountRef><Memo>${escapeXml(memo)}</Memo><Amount>${major(surchargeCents)}</Amount></DepositLineMod>`);
  return `<DepositModRq><DepositMod><TxnID>${qb.TxnID}</TxnID><EditSequence>${qb.EditSequence}</EditSequence>${lines.join("")}</DepositMod></DepositModRq>`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const one = (f: string): string | null => argv.flatMap((a, i) => (a === f && argv[i + 1] ? [argv[i + 1]!] : []))[0] ?? null;
  const from = one("--from") ?? "2026-09-01", to = one("--to") ?? "2026-09-30", only = one("--only"), apply = argv.includes("--apply");
  if (STUB && !String(process.env.DATABASE_URL).includes(":5499/")) throw new Error("MERGE_QB_STUB sólo contra el sandbox :5499");
  const client = await getDbPool().connect();
  try {
    const surchargeAccount = (await client.query<{ q: string }>(`SELECT qb_list_id AS q FROM gl_account_map WHERE key='credit_card_surcharge'`)).rows[0]?.q;
    if (!surchargeAccount) throw new Error("gl_account_map sin credit_card_surcharge");
    const pairs = await loadPairs(client, from, to, only);
    console.log(`lotes de tarjeta con surcharge ${from}→${to}: ${pairs.length}`);
    for (const { batch, bams } of pairs) {
      console.log(`  ${batch.number} ${batch.day} ${batch.qb_txn_id} gross ${batch.gross} · surcharge ${major(batch.surcharge_cents)} · ${bams ? `BAMS ${bams.number} ${bams.qb_txn_id} ${major(bams.cents)}` : "SIN depósito BAMS (¿ya fusionado?)"}`);
    }
    if (!apply) { console.log("\n(dry-run: nada escrito; --apply para fusionar, con readback de cada escritura en QB)"); return; }

    for (const { batch, bams } of pairs) {
      console.log(`\n══ ${batch.number} (${batch.day}) ══`);
      // ── 1. QB: DepositMod del lote (idempotente por readback) ────────────
      const before = await qb.read(batch.qb_txn_id);
      if (!before) throw new Error(`${batch.number}: QB no tiene ${batch.qb_txn_id}`);
      const alreadyHasSurcharge = before.lines.some((l) => !l.TxnID && l.AccountRef?.ListID === surchargeAccount && cents(l.Amount) === batch.surcharge_cents);
      let after: QbDeposit | null = before;
      if (!alreadyHasSurcharge) {
        const expectedTotal = cents(before.DepositTotal) + batch.surcharge_cents;
        await qb.mod(depositModXml(before, surchargeAccount, batch.surcharge_cents, `Card surcharge ${batch.day}`), `merge-surcharge:${batch.qb_txn_id}`, batch.qb_txn_id, surchargeAccount, batch.surcharge_cents, `Card surcharge ${batch.day}`);
        after = await qb.read(batch.qb_txn_id);
        if (!after || cents(after.DepositTotal) !== expectedTotal || after.lines.length !== before.lines.length + 1)
          throw new Error(`${batch.number}: readback tras DepositMod no coincide (total ${after?.DepositTotal} esperado ${major(expectedTotal)}, líneas ${after?.lines.length} esperadas ${before.lines.length + 1}) — DETENIDO`);
        console.log(`  QB DepositMod ✓ total ${before.DepositTotal} → ${after.DepositTotal} (EditSequence ${after.EditSequence})`);
      } else console.log(`  QB ya tenía la línea de surcharge (idempotente)`);

      // ── 2. QB: TxnDel del BAMS ───────────────────────────────────────────
      if (bams) {
        const exists = await qb.read(bams.qb_txn_id);
        if (exists) {
          await qb.del(bams.qb_txn_id, `merge-surcharge-del:${bams.qb_txn_id}`);
          if (await qb.read(bams.qb_txn_id)) throw new Error(`${bams.number}: QB todavía tiene ${bams.qb_txn_id} tras TxnDel — DETENIDO`);
          console.log(`  QB TxnDel ${bams.qb_txn_id} ✓ (readback: no existe)`);
        } else console.log(`  QB ya no tenía ${bams.qb_txn_id} (idempotente)`);
      }

      // ── 3. POS: anular BAMS, re-postear el lote con líneas brutas ────────
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        if (bams) {
          const cur = (await client.query<{ status: string }>(`SELECT status FROM bank_deposit WHERE id=$1`, [bams.id])).rows[0]!;
          if (cur.status !== "void") {
            await reverseBankDepositDocument(client, bams.id, bams.day, `Surcharge fusionado en ${batch.number} (deposit-surcharge-qb-20260915); Deposit BAMS borrado en QB`, ACTOR);
            await client.query(`UPDATE bank_deposit SET status='void', revision=revision+1, voided_by=$2, voided_at=now(), void_reason=$3, qb_txn_id=NULL, qb_txn_type=NULL, qb_synced_at=NULL, updated_at=now() WHERE id=$1`,
              [bams.id, ACTOR, `Fusionado en ${batch.number}: el surcharge es una línea de ingreso del lote (QB TxnDel ${bams.qb_txn_id} verificado)`]);
          }
        }
        const posted = (await client.query<{ posted: boolean; gross: string }>(`SELECT EXISTS(SELECT 1 FROM bank_deposit_line dl WHERE dl.deposit_id=$1 AND dl.deleted_at IS NULL AND dl.payment_id IS NOT NULL AND (dl.payment_snapshot->>'surcharge_merged')='true') AS posted, gross_amount AS gross FROM bank_deposit WHERE id=$1`, [batch.id])).rows[0]!;
        if (!posted.posted) {
          await reverseBankDepositDocument(client, batch.id, batch.day, `Re-posteo con surcharge (deposit-surcharge-qb-20260915)`, ACTOR);
          await client.query(
            `UPDATE bank_deposit_line dl SET amount = ((dl.amount::numeric*100 + COALESCE(cp.surcharge_cents,0))/100)::numeric(30,2)::text,
                    payment_snapshot = dl.payment_snapshot || jsonb_build_object('surcharge_amount', (COALESCE(cp.surcharge_cents,0)::numeric/100)::numeric(30,2)::text, 'surcharge_merged', 'true'),
                    updated_at = now()
               FROM customer_payment cp WHERE cp.id = dl.payment_id AND dl.deposit_id = $1 AND dl.deleted_at IS NULL`, [batch.id]);
          await client.query(`UPDATE bank_deposit SET gross_amount=$2, net_amount=$2, revision=revision+1, updated_at=now(), qb_edit_sequence=$3, qb_synced_at=now() WHERE id=$1`,
            [batch.id, depositMajor(cents(batch.gross) + batch.surcharge_cents), after?.EditSequence ?? null]);
          const resolved = await resolveBankDeposit(client, batch.id);
          const post = await postBankDepositDocument(client, resolved, ACTOR);
          if (post.status !== "posted") throw new Error(`${batch.number}: re-posteo ${post.status}`);
          await client.query(`INSERT INTO bank_review_event (id,entity_type,entity_id,transaction_id,action,actor_id,details) VALUES ($1,'deposit',$2,NULL,'deposit_surcharge_merged',$3,$4::jsonb)`,
            [bankId("bre"), batch.id, ACTOR, JSON.stringify({ surcharge_cents: batch.surcharge_cents.toString(), bams_deposit_id: bams?.id ?? null, bams_qb_txn_id: bams?.qb_txn_id ?? null, entry_id: post.entry_id, qb_edit_sequence: after?.EditSequence ?? null })]);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      }
      // ── 4. readback final: POS = QB ──────────────────────────────────────
      const pos = await loadPosDeposit(batch.id);
      const diffs = compareDeposit(pos, await qb.read(batch.qb_txn_id), { expectSurchargeLine: true });
      if (diffs.length) throw new Error(`${batch.number}: POS ≠ QB tras la fusión: ${diffs.join(" · ")} — DETENIDO`);
      console.log(`  POS re-posteado bruto ${major(cents(batch.gross) + batch.surcharge_cents)} · readback POS = QB ✓`);
    }
    console.log(`\nfusionados ${pairs.length}. Falta: reconcile-feed-statement --mask 7223 --from ${from} --to ${to} --apply --reset (el borrador apuntaba a las líneas viejas).`);
  } finally {
    client.release();
    await getDbPool().end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
