/**
 * swap-bill-payment-to-card — un bill payment por CHEQUE del POS que se canceló y se pagó con
 * TARJETA en QuickBooks (a mano) se endereza en el POS SIN mandar nada nuevo a QB:
 *
 *   1. void del BP por cheque (`voidBillPayment` + reversa del asiento) — su `bill_payment_void`
 *      queda `skipped`: el TxnID ya no existe en QB (lo borraron a mano), un TxnVoid sólo fallaría;
 *   2. reversa del `qb_import` del BillPaymentCreditCard (lo trajo el importador como AP genérico:
 *      no libera los bills del POS) — `void-imported-document` en el mismo script;
 *   3. BP nuevo con método `card` sobre la tarjeta, mismos bills y montos que QB aplicó, posteado al
 *      libro, **adoptando** el TxnID de QB (`qb_txn_id`/`qb_synced_at`) con una fila `bill_payment_add`
 *      `confirmed` marcada adoptada — nunca un BillPaymentCreditCardAdd nuevo (duplicaría en QB). El
 *      importador conoce `vendor_bill_payment.qb_txn_id`, así que no vuelve a traer el doc.
 *
 * Caso que lo motivó (Regions 1416, 2026-09-15): BP-1086 Legrand y BP-1087 All Star (cheques del
 * 09/10, sincronizados como 1CF113/1CF150) se cancelaron y se pagaron con la Visa 2084; en QB
 * borraron los cheques y cargaron 1D108E / 1D10A9. Mismo patrón que CHK-0002 adoptó 1C99CF (09/14).
 *
 *   … ./node_modules/.bin/tsx src/scripts/ledger/swap-bill-payment-to-card.ts \
 *       --void BP-1086 --card 2084 --qb-txn 1D10A9-1789422200 --day 2026-09-14 [--memo 3153469] \
 *       --alloc <vendor_bill.id>=<dólares> [--alloc …] [--actor email] [--apply]
 *
 * Un BP por corrida. DRY-RUN por default; idempotente: BP ya voided → se saltea; BP card con ese
 * TxnID ya adoptado → se saltea; qb_import ya reversado → se saltea. Exige Σ alloc = monto del
 * BillPaymentCreditCard en el libro (`qb_import`) o aborta.
 */
import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { createBillPayment, voidBillPayment } from "../../lib/bill-payments";
import { postBillPayment, reverseBillPayment } from "../../lib/ledger";
import { activeDocumentEntry, reverseDocumentJournal } from "../../lib/ledger/post";
import { enqueueBillPaymentVoid } from "../../lib/purchase-orders/qb-bill-payment-enqueue";
import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
} from "../../lib/purchase-orders/qb-purchase-dependency-chain";
import { clientInTransactionAsKnex } from "../../lib/quickbooks/gl-documents/db-adapters";

type Args = {
  voidNumber: string;
  card: string;
  qbTxn: string;
  day: string;
  memo: string | null;
  allocs: Array<{ bill: string; cents: number }>;
  actor: string;
  apply: boolean;
};

function parseArgs(argv: string[]): Args {
  const values = (flag: string): string[] => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
  const one = (flag: string): string | null => values(flag)[0] ?? null;
  const voidNumber = one("--void"), card = one("--card"), qbTxn = one("--qb-txn"), day = one("--day");
  if (!voidNumber || !card || !qbTxn || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new Error("usage: --void BP-#### --card <4 dígitos> --qb-txn <TxnID QB> --day YYYY-MM-DD --alloc <vendor_bill.id>=<dólares> … [--memo] [--apply]");
  const allocs = values("--alloc").map((raw) => {
    const [bill, dollars] = raw.split("=");
    if (!bill || !dollars || !/^\d+(\.\d{1,2})?$/.test(dollars)) throw new Error(`--alloc espera <vendor_bill.id>=<dólares>, recibió ${raw}`);
    return { bill, cents: Math.round(Number(dollars) * 100) };
  });
  if (!allocs.length) throw new Error("falta al menos un --alloc");
  return { voidNumber, card, qbTxn, day, memo: one("--memo"), allocs, actor: one("--actor") ?? "a.vargas@ecopowertech.com", apply: argv.includes("--apply") };
}

const money = (c: number): string => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function inTx<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = getDbPool();
  const actor = (await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`, [args.actor])).rows[0];
  if (!actor) throw new Error(`actor no encontrado: ${args.actor}`);

  // ── lo que hay ─────────────────────────────────────────────────────────────
  const bp = (await pool.query<{ id: string; status: string; vendor_id: string; vendor: string; amount_cents: string; qb_txn_id: string | null; payment_date: string }>(
    `SELECT id,status,vendor_id,vendor_name_snapshot AS vendor,amount_cents::text,qb_txn_id,payment_date::text FROM vendor_bill_payment WHERE number=$1 AND deleted_at IS NULL`, [args.voidNumber])).rows[0];
  if (!bp) throw new Error(`${args.voidNumber} no existe`);
  const card = (await pool.query<{ qb_list_id: string; name: string; account_type: string }>(
    `SELECT a.qb_list_id,q.full_name AS name,q.account_type FROM bank_account a JOIN qb_account q ON q.qb_list_id=a.qb_list_id WHERE a.mask=$1 AND a.type='credit' AND a.is_selected AND a.deleted_at IS NULL`, [args.card])).rows[0];
  if (!card || card.account_type !== "CreditCard") throw new Error(`*${args.card}: tarjeta no mapeada a una cuenta CreditCard`);
  const reader = await pool.connect();
  const imported = await activeDocumentEntry(reader, "qb_import", args.qbTxn).finally(() => reader.release());
  const importedCents = imported
    ? Number((await pool.query<{ c: string }>(`SELECT COALESCE(sum(credit_cents),0)::text AS c FROM bank_journal_line WHERE entry_id=$1 AND account_list_id=$2`, [imported.id, card.qb_list_id])).rows[0]?.c ?? "0")
    : null;
  const adopted = (await pool.query<{ number: string; status: string }>(`SELECT number,status FROM vendor_bill_payment WHERE qb_txn_id=$1 AND deleted_at IS NULL AND method='card'`, [args.qbTxn])).rows[0];
  const bills = (await pool.query<{ id: string; number: string | null; vendor_id: string; qb_ref_number: string | null; status: string }>(
    `SELECT id,number,vendor_id,qb_ref_number,status FROM vendor_bill WHERE id = ANY($1::text[]) AND deleted_at IS NULL`, [args.allocs.map((a) => a.bill)])).rows;
  const total = args.allocs.reduce((s, a) => s + a.cents, 0);

  console.log(`${args.voidNumber} ${bp.vendor} · ${bp.payment_date} · ${money(Number(bp.amount_cents))} · ${bp.status} · QB ${bp.qb_txn_id ?? "-"}`);
  console.log(`tarjeta *${args.card} = ${card.name}`);
  console.log(`qb_import:${args.qbTxn}: ${imported ? `asiento ${imported.id} día ${imported.day} · crédito a la tarjeta ${money(importedCents ?? 0)}` : "sin asiento activo (ya reversado o no importado)"}`);
  console.log(`BP card adoptando ${args.qbTxn}: ${adopted ? `${adopted.number} (${adopted.status}) — ya existe` : "no existe todavía"}`);
  console.log(`allocations (${money(total)}):`);
  for (const a of args.allocs) {
    const b = bills.find((x) => x.id === a.bill);
    if (!b) throw new Error(`bill ${a.bill} no existe`);
    if (b.vendor_id !== bp.vendor_id) throw new Error(`bill ${b.number ?? b.qb_ref_number} es de otro vendor`);
    console.log(`  ${(b.number ?? b.qb_ref_number ?? b.id).padEnd(14)} ${money(a.cents).padStart(11)}  (${b.status})`);
  }
  if (importedCents !== null && importedCents !== total)
    throw new Error(`Σ alloc ${money(total)} ≠ crédito a la tarjeta del qb_import ${money(importedCents)}: revisar antes de aplicar`);

  const plan = [
    bp.status === "posted" ? `void ${args.voidNumber} + reversa del asiento` : `${args.voidNumber} ya ${bp.status}: se saltea`,
    "fila bill_payment_void → skipped (si no existe; exige QB_VENDOR_BILL_MODE=bill)",
    imported ? `reversa de qb_import:${args.qbTxn} fechada ${args.day}` : `qb_import:${args.qbTxn}: nada que reversar`,
    adopted ? `BP card ya adoptado (${adopted.number}): se saltea` : `BP card ${args.day} en ${card.name} por ${money(total)} adoptando ${args.qbTxn} (sin ADD a QB)`,
  ];
  console.log("\nplan:"); for (const p of plan) console.log(`  - ${p}`);
  if (!args.apply) { console.log("\nDRY-RUN: no se escribió nada. Usá --apply."); return; }

  const client = await pool.connect();
  try {
    // 1. void del BP por cheque (cada paso idempotente por separado: una corrida cortada a la mitad
    //    se reanuda sin saltear la fila de void).
    if (bp.status === "posted") {
      await voidBillPayment(client, bp.id, actor.id, `cancelado: pagado con ${card.name} (QB ${args.qbTxn})`);
      const rev = await inTx(client, () => reverseBillPayment(client, bp.id, actor.id, `cancelado: pagado con tarjeta (QB ${args.qbTxn})`));
      console.log(`void ${args.voidNumber}: reversa ${rev.status}`);
    }
    const voidRow = (await client.query<{ id: string; status: string }>(
      `SELECT id,status FROM qb_order_pipeline WHERE step='bill_payment_void' AND reference_id=$1 ORDER BY created_at DESC LIMIT 1`, [bp.id])).rows[0];
    if (!voidRow) {
      // La fila de void se crea y se marca skipped en la MISMA transacción: el despachador (cron */1)
      // no la ve pendiente ni un instante. El TxnID lo borraron a mano en QB: no hay nada que anular.
      await inTx(client, async () => {
        const knex = clientInTransactionAsKnex(client);
        const q = await enqueueBillPaymentVoid(knex, bp.id);
        if (!q.queued) throw new Error(`no se pudo crear la fila de void: ${q.reason}`);
        await client.query(
          `UPDATE qb_order_pipeline SET status='skipped', error=$2, updated_at=now() WHERE id=$1::uuid AND status IN ('pending','waiting')`,
          [q.pipelineRowId, `TxnID ${bp.qb_txn_id} borrado a mano en QuickBooks; reemplazado por BillPaymentCreditCard ${args.qbTxn}`]
        );
        console.log(`  fila bill_payment_void ${q.pipelineRowId} → skipped`);
      });
    } else {
      console.log(`  fila bill_payment_void ${voidRow.id} ya existe (${voidRow.status})`);
    }
    // 2. reversa del qb_import (AP genérico) — el BP del POS pasa a ser el dueño del asiento
    if (imported) {
      const rev = await inTx(client, () => reverseDocumentJournal(client, { source_kind: "qb_import", source_id: args.qbTxn, day: args.day, reason: `adoptado por bill payment del POS (reemplaza ${args.voidNumber})`, actor_id: actor.id }));
      console.log(`reversa qb_import:${args.qbTxn}: ${rev.status}`);
    }
    // 3. BP por tarjeta, posteado, adoptando el TxnID
    if (!adopted) {
      const created = await createBillPayment(client, {
        vendor_id: bp.vendor_id, bank_account_list_id: card.qb_list_id, payment_date: args.day, method: "card",
        reference: args.memo, memo: `QB BillPaymentCreditCard ${args.qbTxn} adoptado — reemplaza ${args.voidNumber} (cancelado, pagado con tarjeta)`,
        allocations: args.allocs.map((a) => ({ vendor_bill_id: a.bill, amount_cents: a.cents })), actor_id: actor.id,
      });
      const post = await inTx(client, () => postBillPayment(client, created.id, actor.id));
      await inTx(client, async () => {
        await client.query(`UPDATE vendor_bill_payment SET qb_txn_id=$2, qb_synced_at=now(), updated_at=now() WHERE id=$1`, [created.id, args.qbTxn]);
        const knex = clientInTransactionAsKnex(client);
        const payload = { vendor_bill_payment_id: created.id, adopted_qb_txn_id: args.qbTxn, replaces: args.voidNumber };
        const op = await enqueuePurchaseQbOperation(knex, {
          purchaseOrderId: created.id, referenceId: created.id, referenceType: "bill_payment", step: "bill_payment_add",
          payload, qbTxnId: args.qbTxn, operationKey: purchaseOperationKey("bill_payment_add", created.id, payload),
        });
        if (!op) throw new Error("QB_SYNC_ENABLED=false: no se pudo registrar la fila adoptada");
        await client.query(
          `UPDATE qb_order_pipeline SET status='confirmed', qb_txn_id=$2, confirmed_at=now(), error=NULL, qb_result=$3::jsonb, updated_at=now() WHERE id=$1::uuid AND status IN ('pending','waiting')`,
          [op.id, args.qbTxn, JSON.stringify({ adopted: true, qb_txn_id: args.qbTxn, note: "documento creado a mano en QuickBooks; el POS adopta el TxnID, no manda ADD" })]
        );
        console.log(`${created.number} card ${money(total)} → libro ${post.status} · adopta ${args.qbTxn} (fila ${op.id} confirmed)`);
      });
    }
  } finally {
    client.release();
  }
}

main().then(() => process.exit(0)).catch((e: unknown) => { console.error("swap-bill-payment-to-card:", e instanceof Error ? e.message : e); process.exit(1); });
