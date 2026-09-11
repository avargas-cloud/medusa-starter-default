/**
 * backfill-qb-purchases — plan `qb-docs-backfill-compras-20260911`, fases 0-4.
 *
 *   DATABASE_URL=… QB_BRIDGE_URL=… QB_API_KEY=… ECOPOWERTECH_ENV=sandbox \
 *   ./node_modules/.bin/tsx src/scripts/sync/backfill-qb-purchases.ts \
 *     --from 2025-01-01 --to 2026-09-11 --types po,receipt,bill,credit,payment \
 *     [--apply] [--cache-dir .qb-docs-cache] [--run-id qbbf-20260911] [--pause-ms 10000]
 *
 *   … --de-adopt   # fase 3: convierte los vendor_bill qb_source='adopted' en
 *                  # nativos (BillQuery por TxnID en lotes, sin fecha).
 *
 * DRY-RUN por default: descarga (o lee de caché) los 6 requests QBXML por
 * ventana MENSUAL, normaliza, clasifica contra lo que el POS ya conoce, y
 * reporta. `--apply` crea po/receipt/bill/credit/payment EN ORDEN de
 * dependencia (un tipo posterior necesita ver los documentos que el mismo
 * run creó antes — el índice de PO/bills se recarga entre tipos).
 *
 * `--apply`/`--de-adopt` exigen `ECOPOWERTECH_ENV=sandbox` (mismo guard que
 * import-qb-general-ledger.ts) — nunca escribe contra producción.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

import { cachePathFor, directQuery } from "../../lib/qb-backfill/qb-client";
import {
  buildBillByTxnIdsQbxml,
  buildBillPaymentCheckQbxml,
  buildBillPaymentCreditCardQbxml,
  buildBillQbxml,
  buildItemReceiptQbxml,
  buildPurchaseOrderQbxml,
  buildVendorCreditQbxml,
  monthlyWindows,
} from "../../lib/qb-backfill/qb-queries";
import {
  normalizeBillPayments,
  normalizeBills,
  normalizeItemReceipts,
  normalizePurchaseOrders,
  normalizeVendorCredits,
} from "../../lib/qb-backfill/normalize";
import {
  loadBankAccountIndex,
  loadItemIndex,
  loadKnownBillTxnIds,
  loadKnownCreditTxnIds,
  loadKnownPaymentTxnIds,
  loadKnownPoTxnIds,
  loadKnownReceiptTxnIds,
  loadVendorIndex,
  resolveItemRef,
} from "../../lib/qb-backfill/resolve";
import { newEnsureLog } from "../../lib/qb-backfill/ensure";
import { createPurchaseOrderFromQb, decidePoCreation } from "../../lib/qb-backfill/create-po";
import {
  applyBills,
  applyReceipts,
  loadPoIndex,
  makeBankAccountLookup,
  makeQbAccountLookup,
  type ApplyContext,
} from "../../lib/qb-backfill/apply-purchases";
import { applyCredits, applyDeAdopt, applyPayments } from "../../lib/qb-backfill/apply-purchases-money";
import { followLinks, type FollowLinksReport } from "../../lib/qb-backfill/follow-links";
import { USA_LOC } from "../../lib/locations";
import type {
  QbBill,
  QbBillPayment,
  QbDocType,
  QbItemReceipt,
  QbPurchaseOrder,
  QbVendorCredit,
} from "../../lib/qb-backfill/types";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const FROM = arg("from");
const TO = arg("to");
const APPLY = flag("apply");
const DE_ADOPT = flag("de-adopt");
const CACHE_DIR = arg("cache-dir", ".qb-docs-cache") as string;
const RUN_ID = arg("run-id", `qbbf-${Date.now()}`) as string;
const PAUSE_MS = Number(arg("pause-ms", "10000"));
const TYPES = new Set(
  (arg("types", "po,receipt,bill,credit,payment") as string).split(",").map((s) => s.trim())
) as Set<QbDocType>;

if (!FROM || !TO) {
  console.error("uso: --from YYYY-MM-DD --to YYYY-MM-DD [--types po,receipt,bill,credit,payment] [--apply] [--de-adopt] [--cache-dir DIR] [--run-id ID]");
  process.exit(2);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL es obligatoria");
  process.exit(2);
}
if ((APPLY || DE_ADOPT) && process.env.ECOPOWERTECH_ENV !== "sandbox") {
  console.error("--apply/--de-adopt exigen ECOPOWERTECH_ENV=sandbox — este script sólo escribe en sandbox");
  process.exit(2);
}

type Bucket = {
  purchase_orders: QbPurchaseOrder[];
  item_receipts: QbItemReceipt[];
  bills: QbBill[];
  vendor_credits: QbVendorCredit[];
  bill_payments: QbBillPayment[];
};

async function downloadAll(log: (s: string) => void): Promise<Bucket> {
  const bucket: Bucket = { purchase_orders: [], item_receipts: [], bills: [], vendor_credits: [], bill_payments: [] };
  const windows = [...monthlyWindows(FROM as string, TO as string)];
  log(`${windows.length} ventana(s) mensual(es) · tipos: ${[...TYPES].join(",")}`);

  for (const w of windows) {
    const label = `${w.from}..${w.to}`;
    if (TYPES.has("po")) {
      const key = `po_${w.from}_${w.to}`;
      const cached = cachePathFor(CACHE_DIR, key);
      const { rs, cached: hit } = await directQuery(buildPurchaseOrderQbxml(w.from, w.to), "PurchaseOrderQueryRs", {
        cacheDir: CACHE_DIR,
        cacheKey: key,
        log,
      });
      const docs = normalizePurchaseOrders(rs);
      bucket.purchase_orders.push(...docs);
      log(`  [PO] ${label}${hit ? " (caché)" : ""}: ${docs.length} · ${cached}`);
      if (!hit && PAUSE_MS > 0) await sleep(PAUSE_MS);
    }
    if (TYPES.has("receipt")) {
      const key = `receipt_${w.from}_${w.to}`;
      const { rs, cached: hit } = await directQuery(buildItemReceiptQbxml(w.from, w.to), "ItemReceiptQueryRs", {
        cacheDir: CACHE_DIR,
        cacheKey: key,
        log,
      });
      const docs = normalizeItemReceipts(rs);
      bucket.item_receipts.push(...docs);
      log(`  [Receipt] ${label}${hit ? " (caché)" : ""}: ${docs.length}`);
      if (!hit && PAUSE_MS > 0) await sleep(PAUSE_MS);
    }
    if (TYPES.has("bill")) {
      const key = `bill_${w.from}_${w.to}`;
      const { rs, cached: hit } = await directQuery(buildBillQbxml(w.from, w.to), "BillQueryRs", {
        cacheDir: CACHE_DIR,
        cacheKey: key,
        log,
      });
      const docs = normalizeBills(rs);
      bucket.bills.push(...docs);
      log(`  [Bill] ${label}${hit ? " (caché)" : ""}: ${docs.length}`);
      if (!hit && PAUSE_MS > 0) await sleep(PAUSE_MS);
    }
    if (TYPES.has("credit")) {
      const key = `credit_${w.from}_${w.to}`;
      const { rs, cached: hit } = await directQuery(buildVendorCreditQbxml(w.from, w.to), "VendorCreditQueryRs", {
        cacheDir: CACHE_DIR,
        cacheKey: key,
        log,
      });
      const docs = normalizeVendorCredits(rs);
      bucket.vendor_credits.push(...docs);
      log(`  [Credit] ${label}${hit ? " (caché)" : ""}: ${docs.length}`);
      if (!hit && PAUSE_MS > 0) await sleep(PAUSE_MS);
    }
    if (TYPES.has("payment")) {
      const keyChk = `paycheck_${w.from}_${w.to}`;
      const { rs: rsChk, cached: hitChk } = await directQuery(
        buildBillPaymentCheckQbxml(w.from, w.to),
        "BillPaymentCheckQueryRs",
        { cacheDir: CACHE_DIR, cacheKey: keyChk, log }
      );
      bucket.bill_payments.push(...normalizeBillPayments(rsChk, "check"));
      if (!hitChk && PAUSE_MS > 0) await sleep(PAUSE_MS);

      const keyCc = `paycc_${w.from}_${w.to}`;
      const { rs: rsCc, cached: hitCc } = await directQuery(
        buildBillPaymentCreditCardQbxml(w.from, w.to),
        "BillPaymentCreditCardQueryRs",
        { cacheDir: CACHE_DIR, cacheKey: keyCc, log }
      );
      bucket.bill_payments.push(...normalizeBillPayments(rsCc, "credit_card"));
      log(`  [Payment] ${label}: check+cc so far ${bucket.bill_payments.length}`);
      if (!hitCc && PAUSE_MS > 0) await sleep(PAUSE_MS);
    }
  }
  return bucket;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(
    `backfill-qb-purchases ${FROM}..${TO} · run ${RUN_ID} · ${APPLY ? "APPLY" : "DRY-RUN"} · cache ${CACHE_DIR}`
  );
  mkdirSync(CACHE_DIR, { recursive: true });
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const client = await pool.connect();
  const started = Date.now();

  try {
    const bucket = await downloadAll((l) => console.log(l));

    // ── 2025 por ENLACE: sigue LinkedTxn/AppliedToTxnRet de los documentos de
    // 2026 ya descargados hasta que no aparezcan más — corre ANTES de
    // clasificar/aplicar, en dry-run y en --apply por igual (mismo bucket
    // mutable que downloadAll llenó por ventana mensual). ──
    console.log(`\n── follow-links (2025 por enlace) ──`);
    const followLinksReport: FollowLinksReport = await followLinks(bucket, {
      cacheDir: CACHE_DIR,
      pauseMs: PAUSE_MS,
      log: (l) => console.log(l),
    });
    console.log(
      `followLinks: ${followLinksReport.iterations} iteración(es) · traídos por enlace: bill ${followLinksReport.fetched_by_type.bills} · po ${followLinksReport.fetched_by_type.purchase_orders} · receipt ${followLinksReport.fetched_by_type.item_receipts}`
    );
    console.log(`  por año: ${JSON.stringify(followLinksReport.fetched_by_year)}`);
    const viaLinkPoTxnIds = new Set(bucket.purchase_orders.filter((p) => p.via_link).map((p) => p.txn_id));
    const viaLinkReceiptTxnIds = new Set(bucket.item_receipts.filter((r) => r.via_link).map((r) => r.txn_id));
    const viaLinkBillTxnIds = new Set(bucket.bills.filter((b) => b.via_link).map((b) => b.txn_id));

    const [knownPo, knownReceipt, knownBill, knownCredit, knownPayment, vendorIndex, itemIndex, bankIndex] =
      await Promise.all([
        loadKnownPoTxnIds(client),
        loadKnownReceiptTxnIds(client),
        loadKnownBillTxnIds(client),
        loadKnownCreditTxnIds(client),
        loadKnownPaymentTxnIds(client),
        loadVendorIndex(client),
        loadItemIndex(client),
        loadBankAccountIndex(client),
      ]);

    // receipt/bill/credit/payment no se aplican en esta entrega (fase 2 sólo
    // crea PO); los índices ya construidos son para el siguiente executor.
    // Se reportan igual, como ya-conocidos, para que el inventario describa
    // el alcance completo de los 5 tipos.
    console.log(`\n── Ya conocidos por el POS (índices para el siguiente executor) ──`);
    console.log(`ItemReceipt: ${bucket.item_receipts.filter((r) => knownReceipt.has(r.txn_id)).length}/${bucket.item_receipts.length}`);
    console.log(`Bill: ${bucket.bills.filter((b) => knownBill.has(b.txn_id)).length}/${bucket.bills.length}`);
    console.log(`VendorCredit: ${bucket.vendor_credits.filter((c) => knownCredit.has(c.txn_id)).length}/${bucket.vendor_credits.length}`);
    console.log(`BillPayment: ${bucket.bill_payments.filter((p) => knownPayment.has(p.txn_id)).length}/${bucket.bill_payments.length}`);

    // ── Reporte por tipo/año ────────────────────────────────────────────
    const byYear = <T extends { txn_date: string }>(docs: T[]) => {
      const m = new Map<string, number>();
      for (const d of docs) m.set(d.txn_date.slice(0, 4), (m.get(d.txn_date.slice(0, 4)) ?? 0) + 1);
      return Object.fromEntries([...m.entries()].sort());
    };
    console.log("\n── Conteos por tipo ──");
    console.log(`PO: ${bucket.purchase_orders.length} · por año ${JSON.stringify(byYear(bucket.purchase_orders))}`);
    console.log(`ItemReceipt: ${bucket.item_receipts.length} · por año ${JSON.stringify(byYear(bucket.item_receipts))}`);
    console.log(`Bill: ${bucket.bills.length} · por año ${JSON.stringify(byYear(bucket.bills))}`);
    console.log(`VendorCredit: ${bucket.vendor_credits.length} · por año ${JSON.stringify(byYear(bucket.vendor_credits))}`);
    console.log(`BillPayment: ${bucket.bill_payments.length} · por año ${JSON.stringify(byYear(bucket.bill_payments))}`);

    // ── Faltantes: vendors, ítems, cuentas bancarias ────────────────────
    const missingVendors = new Map<string, { list_id: string; full_name: string; count: number }>();
    const missingItems = new Map<string, { list_id: string; full_name: string; count: number }>();
    const missingBanks = new Map<string, { list_id: string; full_name: string; count: number }>();

    const bump = (m: Map<string, { list_id: string; full_name: string; count: number }>, ref: { list_id: string; full_name: string } | null) => {
      if (!ref) return;
      const e = m.get(ref.list_id) ?? { list_id: ref.list_id, full_name: ref.full_name, count: 0 };
      e.count += 1;
      m.set(ref.list_id, e);
    };

    for (const po of bucket.purchase_orders) {
      if (po.vendor_ref && !vendorIndex.has(po.vendor_ref.list_id)) bump(missingVendors, po.vendor_ref);
      for (const l of po.lines) if (l.item_ref && !resolveItemRef(itemIndex, l.item_ref)) bump(missingItems, l.item_ref);
    }
    for (const p of bucket.bill_payments) {
      const bankRef = p.bank_account_ref ?? p.credit_card_account_ref;
      if (bankRef && !bankIndex.has(bankRef.list_id)) bump(missingBanks, bankRef);
    }

    console.log(`\nVendors faltantes: ${missingVendors.size}`);
    for (const v of missingVendors.values()) console.log(`  ${v.list_id} ${v.full_name} (${v.count} doc)`);
    console.log(`Ítems faltantes: ${missingItems.size}`);
    for (const it of missingItems.values()) console.log(`  ${it.list_id} ${it.full_name} (${it.count} doc)`);
    console.log(`Cuentas bancarias faltantes: ${missingBanks.size}`);
    for (const b of missingBanks.values()) console.log(`  ${b.list_id} ${b.full_name} (${b.count} doc)`);

    // ── PO: clasificación de alcance ────────────────────────────────────
    let poAlready = 0, poCreate = 0, poClosed2025 = 0, poBlocked = 0;
    const blockedPos: { txn_id: string; reason: string }[] = [];
    const ensureLog = newEnsureLog();
    const createdPos: { txn_id: string; number: string; status: string }[] = [];

    if (TYPES.has("po")) {
      for (const po of bucket.purchase_orders) {
        const decision = decidePoCreation(po, knownPo);
        if (decision.reason === "already") { poAlready++; continue; }
        if (decision.reason === "closed_2025") { poClosed2025++; continue; }
        poCreate++;
        if (!APPLY) continue;
        try {
          await client.query("BEGIN");
          const result = await createPurchaseOrderFromQb(client, po, {
            runId: RUN_ID,
            vendorIndex,
            itemIndex,
            ensureLog,
            stockLocationId: USA_LOC,
            createdByUserId: "qb-backfill-system",
          });
          await client.query("COMMIT");
          createdPos.push({ txn_id: po.txn_id, number: result.number, status: result.status });
        } catch (err) {
          await client.query("ROLLBACK");
          poBlocked++;
          blockedPos.push({ txn_id: po.txn_id, reason: (err as Error).message });
        }
      }
    }

    console.log(`\n── Purchase Orders ──`);
    console.log(`ya conocidos: ${poAlready} · 2025 cerrados (skip): ${poClosed2025} · a crear: ${poCreate} · bloqueados: ${poBlocked}`);
    if (APPLY) {
      console.log(`creados: ${createdPos.length}`);
      console.log(`  de los cuales por enlace (via_link): ${createdPos.filter((c) => viaLinkPoTxnIds.has(c.txn_id)).length}/${viaLinkPoTxnIds.size}`);
      for (const c of createdPos.slice(0, 30)) console.log(`  ${c.txn_id} → ${c.number} (${c.status})`);
      if (blockedPos.length) {
        console.log(`bloqueados:`);
        for (const b of blockedPos) console.log(`  ${b.txn_id}: ${b.reason}`);
      }
      if (ensureLog.vendors_created.length) {
        console.log(`vendors creados: ${ensureLog.vendors_created.length}`);
        for (const v of ensureLog.vendors_created) console.log(`  ${v.qb_list_id} ${v.full_name} → ${v.id}`);
      }
      if (ensureLog.items_created.length) {
        console.log(`ítems creados: ${ensureLog.items_created.length}`);
        for (const it of ensureLog.items_created) console.log(`  ${it.qb_list_id} ${it.full_name} → ${it.variant_id} (sku ${it.sku})`);
      }
    }

    // ── receipt → bill → credit → payment (en ese orden — cada uno puede
    // necesitar ver lo que el tipo anterior acaba de crear en este mismo run) ──
    const ctx: ApplyContext = {
      client,
      runId: RUN_ID,
      itemIndex,
      vendorIndex,
      ensureLog,
      createdByUserId: "qb-backfill-system",
      stockLocationId: USA_LOC,
    };
    const resolveQbAccount = makeQbAccountLookup(client);
    const resolveBankAccount = makeBankAccountLookup(client);

    let poIndex = await loadPoIndex(client);
    const receiptReport = TYPES.has("receipt")
      ? await applyReceipts(bucket.item_receipts, knownReceipt, poIndex, ctx, APPLY)
      : null;
    console.log(`\n── Item Receipts ──`);
    if (receiptReport) {
      console.log(`ya conocidos: ${receiptReport.already} · a crear: ${receiptReport.create} · bloqueados: ${receiptReport.blocked.length}`);
      if (APPLY) {
        console.log(`creados: ${receiptReport.created.length}`);
        console.log(`  de los cuales por enlace (via_link): ${receiptReport.created.filter((c) => viaLinkReceiptTxnIds.has(c.txn_id)).length}/${viaLinkReceiptTxnIds.size}`);
        for (const b of receiptReport.blocked) console.log(`  bloqueado ${b.txn_id}: ${b.blocked_reason}`);
      }
    } else {
      console.log(`--types no incluye 'receipt' — sin clasificar`);
    }

    poIndex = await loadPoIndex(client); // un receipt no crea POs, pero puede haber corrido junto a --types po
    const billReport = TYPES.has("bill")
      ? await applyBills(bucket.bills, knownBill, poIndex, resolveQbAccount, ctx, APPLY)
      : null;
    console.log(`\n── Vendor Bills ──`);
    if (billReport) {
      console.log(
        `ya conocidos: ${billReport.already} · a crear: ${billReport.create} · bloqueados: ${billReport.blocked.length} · recibos enlazados: ${billReport.receipts_linked} · recibos sintéticos: ${billReport.synthetic_receipts}`
      );
      if (APPLY) {
        console.log(`creados: ${billReport.created.length}`);
        console.log(`  de los cuales por enlace (via_link): ${billReport.created.filter((c) => viaLinkBillTxnIds.has(c.txn_id)).length}/${viaLinkBillTxnIds.size}`);
        for (const b of billReport.blocked) console.log(`  bloqueado ${b.txn_id}: ${b.blocked_reason}`);
      }
    } else {
      console.log(`--types no incluye 'bill' — sin clasificar`);
    }

    poIndex = await loadPoIndex(client);
    const creditReport = TYPES.has("credit")
      ? await applyCredits(bucket.vendor_credits, knownCredit, poIndex, resolveQbAccount, ctx, APPLY)
      : null;
    console.log(`\n── Vendor Credits ──`);
    if (creditReport) {
      console.log(`ya conocidos: ${creditReport.already} · a crear: ${creditReport.create} · bloqueados: ${creditReport.blocked.length}`);
      if (APPLY) {
        console.log(`creados: ${creditReport.created.length}`);
        for (const b of creditReport.blocked) console.log(`  bloqueado ${b.txn_id}: ${b.blocked_reason}`);
      }
    } else {
      console.log(`--types no incluye 'credit' — sin clasificar`);
    }

    const paymentReport = TYPES.has("payment")
      ? await applyPayments(bucket.bill_payments, knownPayment, resolveBankAccount, ctx, APPLY)
      : null;
    console.log(`\n── Bill Payments ──`);
    if (paymentReport) {
      console.log(`ya conocidos: ${paymentReport.already} · a crear: ${paymentReport.create} · bloqueados: ${paymentReport.blocked.length}`);
      if (APPLY) {
        console.log(`creados: ${paymentReport.created.length}`);
        for (const b of paymentReport.blocked) console.log(`  bloqueado ${b.txn_id}: ${b.blocked_reason}`);
      }
    } else {
      console.log(`--types no incluye 'payment' — sin clasificar`);
    }

    // ── de-adopt (fase 3) — corre APARTE del loop por tipos; batchea por lotes de 10 TxnID ──
    let deAdoptReport: Awaited<ReturnType<typeof applyDeAdopt>> | null = null;
    if (DE_ADOPT) {
      const { rows: adoptedRows } = await client.query(
        `SELECT qb_txn_id FROM vendor_bill WHERE qb_source = 'adopted' AND deleted_at IS NULL AND qb_txn_id IS NOT NULL`
      );
      const adoptedTxnIds = (adoptedRows as { qb_txn_id: string }[]).map((r) => r.qb_txn_id);
      console.log(`\n── De-adopt (${adoptedTxnIds.length} bill(s) adoptado(s)) ──`);
      const qbBills: QbBill[] = [];
      const missingFromQb: string[] = [];
      const BATCH = 10;
      for (let i = 0; i < adoptedTxnIds.length; i += BATCH) {
        const batch = adoptedTxnIds.slice(i, i + BATCH);
        const key = `deadopt_batch_${i / BATCH}`;
        try {
          const { rs } = await directQuery(buildBillByTxnIdsQbxml(batch), "BillQueryRs", {
            cacheDir: CACHE_DIR,
            cacheKey: key,
            log: (l) => console.log(l),
          });
          qbBills.push(...normalizeBills(rs));
        } catch (err) {
          // Sondeado: un BillQueryRq con VARIOS <TxnID> falla el LOTE ENTERO
          // (statusCode 500) si UNO solo no existe en QB — no hay resultado
          // parcial. Fallback per-TxnID sólo para este lote.
          console.log(`  lote ${key} falló (${(err as Error).message.slice(0, 100)}) — reintentando 1x1`);
          for (const txnId of batch) {
            try {
              const { rs } = await directQuery(buildBillByTxnIdsQbxml([txnId]), "BillQueryRs", {
                cacheDir: CACHE_DIR,
                cacheKey: `deadopt_single_${txnId}`,
                log: (l) => console.log(l),
              });
              qbBills.push(...normalizeBills(rs));
            } catch (err2) {
              missingFromQb.push(txnId);
              console.log(`    ${txnId}: ${(err2 as Error).message.slice(0, 100)}`);
            }
            if (PAUSE_MS > 0) await sleep(PAUSE_MS);
          }
        }
        if (PAUSE_MS > 0) await sleep(PAUSE_MS);
      }
      deAdoptReport = await applyDeAdopt(qbBills, ctx, resolveQbAccount);
      for (const txnId of missingFromQb) {
        deAdoptReport.blocked.push({ txn_id: txnId, blocked_reason: "qb_txn_not_found" });
      }
      console.log(
        `adoptados antes: ${deAdoptReport.total_adopted} · de-adoptados: ${deAdoptReport.de_adopted} · líneas agregadas: ${deAdoptReport.lines_added_total} · bloqueados: ${deAdoptReport.blocked.length}`
      );
      for (const b of deAdoptReport.blocked) console.log(`  bloqueado ${b.txn_id}: ${b.blocked_reason}`);
    }

    // ── Inventario a disco ───────────────────────────────────────────────
    const inventoryPath = join(CACHE_DIR, `inventario_${RUN_ID}.json`);
    writeFileSync(
      inventoryPath,
      JSON.stringify(
        {
          run_id: RUN_ID,
          from: FROM,
          to: TO,
          apply: APPLY,
          de_adopt: DE_ADOPT,
          counts: {
            po: bucket.purchase_orders.length,
            receipt: bucket.item_receipts.length,
            bill: bucket.bills.length,
            credit: bucket.vendor_credits.length,
            payment: bucket.bill_payments.length,
          },
          follow_links: followLinksReport,
          po_scope: { already: poAlready, create: poCreate, closed_2025: poClosed2025, blocked: poBlocked },
          receipt_scope: receiptReport,
          bill_scope: billReport,
          credit_scope: creditReport,
          payment_scope: paymentReport,
          de_adopt_scope: deAdoptReport,
          missing_vendors: [...missingVendors.values()],
          missing_items: [...missingItems.values()],
          missing_banks: [...missingBanks.values()],
          created_pos: createdPos,
          ensure_log: ensureLog,
        },
        null,
        1
      )
    );
    console.log(`\nInventario: ${inventoryPath}`);
    console.log(`Tiempo total: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
