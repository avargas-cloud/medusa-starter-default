/**
 * verify-qb-sales-backfill — plan `qb-sales-backfill-20260911`, fase VERIFY.
 * SÓLO LECTURA: la DB se consulta, nunca se escribe.
 *
 *   DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/verify/verify-qb-sales-backfill.ts \
 *     --run-id qbsb-20260911 --cache-dir .qb-docs-cache \
 *     [--apply-report .qb-docs-cache/sales-apply_<run>.json] [--admin-url http://localhost:9096] \
 *     [--sample 20] [--stock-before path.json] [--skip-fulfillment]
 *
 * Fuente de verdad QB = la caché cruda (`invoice_*`, `salesreceipt_*`,
 * `receivepayment_*`, `creditmemo_*`, `*_bytxn_*`, `invoice_unpaid_2025-*`)
 * normalizada por `sales-normalize.ts` — NO la clasificación, que sólo aporta
 * el universo `create` (y `via_link`). El reporte del apply aporta los
 * bloqueados y el conteo de `unlinked_application`.
 *
 * Checks (cada uno imprime ✓/✗ con conteos; cualquier ✗ → exit 1):
 *  (a) cada TxnID `create` (menos los bloqueados del apply) existe EXACTAMENTE
 *      una vez en el POS por su tabla/tipo, y nada con el marcador del run
 *      apunta a un TxnID fuera de la clasificación;
 *  (b) totales en cents contra QB (invoice: Subtotal+SalesTaxTotal; SR: TotalAmount;
 *      pago: TotalAmount; CM: TotalAmount) y `tax` = SalesTaxTotal — primeros 5 mismatches;
 *  (c) factura: `IsPaid` ⇒ paid/balance 0; si no, balance = BalanceRemaining y status issued|partial;
 *  (d) aplicaciones: Σ `payment_application` = Σ `AppliedToTxn.Amount` de facturas que el POS
 *      conoce; las no enlazadas (INFO) = `unlinked_application` del apply; SR aplicado = su total;
 *  (e) fechas (`::date` en UTC, `businessInstant` = 16:00Z) = TxnDate en factura, pago, CM y orden;
 *  (f) numeración histórica (< go-live) `S0000`/`00000`/`CM-0000`, post go-live NO; orden
 *      histórico estrictamente cronológico (empates permitidos); sin duplicados;
 *  (g) stock intacto: `inventory_level` y `reservation_item` contra `--stock-before` o los
 *      literales medidos antes del run (con aviso);
 *  (h) 0 filas despachables de pipeline para el run; cada documento creado tiene su fila
 *      confirmada con el `qb_txn_id` correcto;
 *  (i) regla 2025: ningún SR creado con fecha 2025; toda factura 2025 creada es `via_link`
 *      o está en la caché de impagas 2025;
 *  (j) identidad para el GL importer: `loadPosKnownTxnIds` (pos-links.ts) conoce la muestra;
 *  (k) muestra responde 200 en `GET /admin/invoices/:id`, `/admin/pos/credit_memos/:id`,
 *      `/admin/finance/payments/:id`;
 *  (l) cada orden creada tiene fulfillment vivo (`order_fulfillment`) o es una orden sin
 *      ítems (la que `fulfill-backfilled-qb-orders.ts` rechaza con "no tiene ítems");
 *      `--skip-fulfillment` lo degrada a INFO si el script aún corre;
 *  (m) no-vacuidad: created > 0 en los 4 tipos;
 *  (n) aplicaciones de CM: todo CM del run con `LinkedTxn Invoice` negativo cuya factura el
 *      POS conoce tiene una `payment_application` de un pago `type='credit_memo'`
 *      (`metadata.qb_txn_id` = CM) con `amount_applied` = |Amount|; (n2) las facturas del run
 *      `paid` con total > 0 y sin aplicación son exactamente las que en QB no tienen ni
 *      ReceivePayment ni CM enlazado (se imprimen: pagos posteriores a `--to` o refunds).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";

import { normalizeCreditMemos, normalizeInvoices, normalizeReceivePayments, normalizeSalesReceipts } from "../../lib/qb-backfill/sales-normalize";
import { invoiceTotalCents } from "../../lib/qb-backfill/sales-derive";
import { isHistoricalSalesDate } from "../../lib/qb-backfill/sales-numbering";
import { loadPosKnownTxnIds } from "../../lib/ledger/qb-import/pos-links";
import { findPosInvoiceByQbTxnId } from "../../lib/qb-backfill/sales-context";
import type { SalesApplyReport } from "../../lib/qb-backfill/apply-sales";
import type { QbCreditMemo, QbInvoice, QbReceivePayment, QbSalesReceipt } from "../../lib/qb-backfill/sales-types";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

const RUN_ID = arg("run-id");
const CACHE_DIR = arg("cache-dir", ".qb-docs-cache") as string;
const ADMIN_URL = arg("admin-url", "http://localhost:9096") as string;
const SAMPLE = Number(arg("sample", "20"));
const STOCK_BEFORE = arg("stock-before");
const APPLY_REPORT = arg("apply-report", join(CACHE_DIR, `sales-apply_${RUN_ID}.json`)) as string;
const SKIP_FULFILLMENT = process.argv.includes("--skip-fulfillment");

/** Medido en el sandbox `medusa_bankgl` ANTES del run qbsb-20260911 (spec del verificador). */
const STOCK_BEFORE_DEFAULT = { stocked: "42597", reserved: "1895", n: "2866", reservations: "9189" };

if (!RUN_ID) {
  console.error("uso: --run-id ID [--cache-dir DIR] [--apply-report path.json] [--admin-url URL] [--sample N] [--stock-before path.json] [--skip-fulfillment]");
  process.exit(2);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL es obligatoria");
  process.exit(2);
}

// ── tipos de los archivos de entrada ─────────────────────────────────────

interface ClassificationFile {
  invoices: { create: QbInvoice[] };
  sales_receipts: { create: QbSalesReceipt[] };
  payments?: { create: QbReceivePayment[] };
  receive_payments?: { create: QbReceivePayment[] };
  credit_memos: { create: QbCreditMemo[] };
}
interface ApplyReportFile {
  run_id: string;
  report: SalesApplyReport;
}
type Row = Record<string, string | number | boolean | null>;

let failures = 0;
function check(letter: string, ok: boolean, msg: string): void {
  if (ok) console.log(`✓ (${letter}) ${msg}`);
  else {
    console.error(`✗ (${letter}) ${msg}`);
    failures++;
  }
}
function info(letter: string, msg: string): void {
  console.log(`  (${letter}) INFO: ${msg}`);
}
function cents(v: string | number | boolean | null | undefined): number {
  return Math.round(Number(v ?? 0));
}
/** Imprime hasta 5 detalles de una lista de mismatches. */
function showFirst(details: string[]): void {
  for (const d of details.slice(0, 5)) console.error(`    · ${d}`);
  if (details.length > 5) console.error(`    · … +${details.length - 5}`);
}

// ── caché QB → mapas por TxnID ───────────────────────────────────────────

function loadCache<T extends { txn_id: string }>(prefixes: RegExp, normalize: (rs: Record<string, unknown> | null) => T[]): Map<string, T> {
  const out = new Map<string, T>();
  const files = readdirSync(CACHE_DIR).filter((f) => prefixes.test(f)).sort();
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(CACHE_DIR, f), "utf8")) as Record<string, unknown> | null;
    for (const d of normalize(raw)) out.set(d.txn_id, d);
  }
  return out;
}

async function fetchToken(): Promise<string> {
  const res = await fetch(`${ADMIN_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "sandbox@test.com", password: "sandbox123" }),
  });
  if (!res.ok) throw new Error(`login sandbox falló: ${res.status}`);
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error("login sandbox sin token");
  return json.token;
}

/** Cuenta ocurrencias por TxnID y afirma exactamente-una para cada esperado. */
function exactlyOnce(letter: string, label: string, expected: Set<string>, rows: Row[], key: string): Map<string, Row> {
  const count = new Map<string, number>();
  const byTxn = new Map<string, Row>();
  for (const r of rows) {
    const t = String(r[key] ?? "");
    if (!expected.has(t)) continue;
    count.set(t, (count.get(t) ?? 0) + 1);
    byTxn.set(t, r);
  }
  const missing = [...expected].filter((t) => !count.has(t));
  const dup = [...count].filter(([, n]) => n > 1).map(([t, n]) => `${t} ×${n}`);
  check(letter, missing.length === 0 && dup.length === 0, `${label}: ${byTxn.size - dup.length}/${expected.size} exactamente una vez (faltan ${missing.length}, duplicados ${dup.length})`);
  showFirst([...missing.map((t) => `falta ${t}`), ...dup.map((d) => `duplicado ${d}`)]);
  return byTxn;
}

async function main(): Promise<void> {
  const classPath = join(CACHE_DIR, `sales-classification_${RUN_ID}.json`);
  if (!existsSync(classPath)) throw new Error(`no existe ${classPath} — corré backfill-qb-sales.ts primero`);
  if (!existsSync(APPLY_REPORT)) throw new Error(`no existe el reporte del apply ${APPLY_REPORT} (--apply-report)`);
  const classification = JSON.parse(readFileSync(classPath, "utf8")) as ClassificationFile;
  const applyFile = JSON.parse(readFileSync(APPLY_REPORT, "utf8")) as ApplyReportFile;
  if (applyFile.run_id !== RUN_ID) throw new Error(`el reporte del apply es del run ${applyFile.run_id}, no de ${RUN_ID}`);
  const report = applyFile.report;

  const qbInv = loadCache(/^invoice_(\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}|bytxn_[0-9a-f]+|unpaid_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2})\.json$/, normalizeInvoices);
  const qbSr = loadCache(/^salesreceipt_(\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}|bytxn_[0-9a-f]+)\.json$/, normalizeSalesReceipts);
  const qbRp = loadCache(/^receivepayment_(\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}|bytxn_[0-9a-f]+)\.json$/, normalizeReceivePayments);
  const qbCm = loadCache(/^creditmemo_(\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}|bytxn_[0-9a-f]+)\.json$/, normalizeCreditMemos);
  const unpaid2025 = new Set<string>();
  const unpaidPath = join(CACHE_DIR, "invoice_unpaid_2025-01-01_2025-12-31.json");
  if (existsSync(unpaidPath)) {
    for (const d of normalizeInvoices(JSON.parse(readFileSync(unpaidPath, "utf8")))) unpaid2025.add(d.txn_id);
  }
  console.log(`caché QB: invoices ${qbInv.size} · sales receipts ${qbSr.size} · pagos ${qbRp.size} · credit memos ${qbCm.size} · impagas 2025 ${unpaid2025.size}`);

  // universo `create` menos bloqueados del apply
  const blocked = (t: SalesApplyReport["invoices"]) => new Set(t.blocked.map((b) => b.txn_id));
  const expect = <T extends { txn_id: string }>(docs: T[], t: SalesApplyReport["invoices"]) => {
    const b = blocked(t);
    return new Set(docs.filter((d) => !b.has(d.txn_id)).map((d) => d.txn_id));
  };
  const classPayments = classification.payments ?? classification.receive_payments ?? { create: [] };
  const expInv = expect(classification.invoices.create, report.invoices);
  const expSr = expect(classification.sales_receipts.create, report.sales_receipts);
  const expRp = expect(classPayments.create, report.receive_payments);
  const expCm = expect(classification.credit_memos.create, report.credit_memos);
  const classDocs = new Map<string, QbInvoice | QbSalesReceipt | QbReceivePayment | QbCreditMemo>();
  for (const d of [...classification.invoices.create, ...classification.sales_receipts.create, ...classPayments.create, ...classification.credit_memos.create]) classDocs.set(d.txn_id, d);
  const allCreate = new Set(classDocs.keys());
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const client: PoolClient = await pool.connect();
  try {
    // ── filas del POS ────────────────────────────────────────────────────
    const { rows: invRows } = await client.query<Row>(
      `SELECT i.id, i.invoice_number, i.order_id, i.status, i.total, i.tax, i.balance_due,
              (i.issued_at AT TIME ZONE 'UTC')::date::text AS issued_date,
              i.metadata->>'qb_txn_id' AS txn_id,
              (i.metadata->>'is_sales_receipt')::boolean AS is_sr,
              i.metadata->'qb_backfill'->>'run_id' AS run_id,
              i.metadata->'qb_backfill'->>'txn_id' AS marker_txn
         FROM pos_invoice i
        WHERE i.deleted_at IS NULL
          AND (i.metadata->>'qb_txn_id' = ANY($1::text[]) OR i.metadata->'qb_backfill'->>'run_id' = $2)`,
      [[...expInv, ...expSr], RUN_ID]
    );
    const { rows: payRows } = await client.query<Row>(
      `SELECT p.id, p.display_id, p.amount, p.status,
              (p.received_at AT TIME ZONE 'UTC')::date::text AS received_date,
              p.metadata->>'qb_txn_id' AS txn_id,
              p.metadata->>'qb_parent_txn_id' AS parent_txn,
              p.metadata->'qb_backfill'->>'run_id' AS run_id,
              p.metadata->'qb_backfill'->>'txn_id' AS marker_txn
         FROM customer_payment p
        WHERE p.deleted_at IS NULL
          AND (p.metadata->>'qb_txn_id' = ANY($1::text[]) OR p.metadata->'qb_backfill'->>'run_id' = $2)`,
      [[...expRp], RUN_ID]
    );
    const { rows: cmRows } = await client.query<Row>(
      `SELECT c.id, c.credit_memo_number, c.total, c.status,
              (c.completed_at AT TIME ZONE 'UTC')::date::text AS completed_date,
              c.qb_txn_id AS txn_id,
              c.metadata->'qb_backfill'->>'run_id' AS run_id,
              c.metadata->'qb_backfill'->>'txn_id' AS marker_txn
         FROM pos_credit_memo c
        WHERE c.deleted_at IS NULL AND (c.qb_txn_id = ANY($1::text[]) OR c.metadata->'qb_backfill'->>'run_id' = $2)`,
      [[...expCm], RUN_ID]
    );
    const { rows: orderRows } = await client.query<Row>(
      `SELECT o.id, o.metadata->>'document_number' AS document_number,
              (o.created_at AT TIME ZONE 'UTC')::date::text AS created_date,
              o.metadata->'qb_backfill'->>'txn_id' AS marker_txn,
              o.metadata->>'qb_invoice_txn_id' AS inv_txn,
              o.metadata->>'qb_sales_receipt_txn_id' AS sr_txn,
              (SELECT count(*) FROM order_item oi WHERE oi.order_id = o.id AND oi.deleted_at IS NULL)::int AS n_items,
              (SELECT count(*) FROM order_fulfillment ofl
                 JOIN fulfillment f ON f.id = ofl.fulfillment_id AND f.deleted_at IS NULL AND f.canceled_at IS NULL
                WHERE ofl.order_id = o.id AND ofl.deleted_at IS NULL)::int AS live_fulfillments
         FROM "order" o
        WHERE o.deleted_at IS NULL AND o.metadata->'qb_backfill'->>'run_id' = $1`,
      [RUN_ID]
    );

    // ── (a) exactamente una vez + nada fuera de la clasificación ─────────
    const invByTxn = exactlyOnce("a", "invoice → pos_invoice (no SR)", expInv, invRows.filter((r) => r.is_sr !== true), "txn_id");
    const srByTxn = exactlyOnce("a", "sales receipt → pos_invoice (is_sales_receipt)", expSr, invRows.filter((r) => r.is_sr === true), "txn_id");
    const rpByTxn = exactlyOnce("a", "receive payment → customer_payment", expRp, payRows.filter((r) => r.parent_txn == null), "txn_id");
    const cmByTxn = exactlyOnce("a", "credit memo → pos_credit_memo", expCm, cmRows, "txn_id");
    const orderByTxn = exactlyOnce("a", "orden (marcador) → order", new Set([...expInv, ...expSr]), orderRows, "marker_txn");
    const strays: string[] = [];
    for (const [label, rows] of [["pos_invoice", invRows], ["customer_payment", payRows], ["pos_credit_memo", cmRows], ["order", orderRows]] as const) {
      for (const r of rows) if (r.run_id === RUN_ID || label === "order") {
        if (!allCreate.has(String(r.marker_txn))) strays.push(`${label} ${r.id} marcado ${RUN_ID} con txn ${r.marker_txn} fuera de la clasificación`);
      }
    }
    check("a", strays.length === 0, `filas con marcador ${RUN_ID} fuera de la clasificación: ${strays.length}`);
    showFirst(strays);
    const reportedCreated = new Set([...report.invoices.created, ...report.sales_receipts.created, ...report.receive_payments.created, ...report.credit_memos.created].map((c) => c.txn_id));
    const expAll = new Set([...expInv, ...expSr, ...expRp, ...expCm]);
    const diff = [...expAll].filter((t) => !reportedCreated.has(t)).concat([...reportedCreated].filter((t) => !expAll.has(t)));
    check("a", diff.length === 0, `clasificación−bloqueados (${expAll.size}) == created del apply (${reportedCreated.size}); diferencia ${diff.length}`);
    showFirst(diff);

    // ── (b) totales ──────────────────────────────────────────────────────
    const bad: string[] = [];
    let nb = 0;
    for (const [t, r] of invByTxn) {
      const qb = qbInv.get(t);
      if (!qb) { bad.push(`invoice ${t}: sin caché QB`); continue; }
      nb++;
      if (cents(r.total) !== invoiceTotalCents(qb)) bad.push(`invoice ${r.invoice_number} (${t}): total ${cents(r.total)} ≠ QB ${invoiceTotalCents(qb)}`);
      if (cents(r.tax) !== qb.sales_tax_total_cents) bad.push(`invoice ${r.invoice_number} (${t}): tax ${cents(r.tax)} ≠ QB ${qb.sales_tax_total_cents}`);
    }
    for (const [t, r] of srByTxn) {
      const qb = qbSr.get(t);
      if (!qb) { bad.push(`SR ${t}: sin caché QB`); continue; }
      nb++;
      if (cents(r.total) !== qb.total_amount_cents) bad.push(`SR ${r.invoice_number} (${t}): total ${cents(r.total)} ≠ QB ${qb.total_amount_cents}`);
      if (cents(r.tax) !== qb.sales_tax_total_cents) bad.push(`SR ${r.invoice_number} (${t}): tax ${cents(r.tax)} ≠ QB ${qb.sales_tax_total_cents}`);
    }
    for (const [t, r] of rpByTxn) {
      const qb = qbRp.get(t);
      if (!qb) { bad.push(`pago ${t}: sin caché QB`); continue; }
      nb++;
      if (cents(r.amount) !== qb.total_amount_cents) bad.push(`pago PAY-${r.display_id} (${t}): amount ${cents(r.amount)} ≠ QB ${qb.total_amount_cents}`);
    }
    for (const [t, r] of cmByTxn) {
      const qb = qbCm.get(t);
      if (!qb) { bad.push(`CM ${t}: sin caché QB`); continue; }
      nb++;
      if (cents(r.total) !== qb.total_amount_cents) bad.push(`CM ${r.credit_memo_number} (${t}): total ${cents(r.total)} ≠ QB ${qb.total_amount_cents}`);
    }
    check("b", bad.length === 0 && nb > 0, `totales/tax en cents contra caché QB: ${nb} documento(s) evaluados, ${bad.length} mismatch(es)`);
    showFirst(bad);

    // ── (c) status/balance de facturas ───────────────────────────────────
    const badC: string[] = [];
    for (const [t, r] of invByTxn) {
      const qb = qbInv.get(t);
      if (!qb) continue;
      if (qb.is_paid) {
        if (r.status !== "paid" || cents(r.balance_due) !== 0) badC.push(`invoice ${r.invoice_number} (${t}): IsPaid pero status ${r.status} balance ${cents(r.balance_due)}`);
      } else if (cents(r.balance_due) !== qb.balance_remaining_cents || !["issued", "partial"].includes(String(r.status))) {
        badC.push(`invoice ${r.invoice_number} (${t}): status ${r.status} balance ${cents(r.balance_due)} vs QB BalanceRemaining ${qb.balance_remaining_cents}`);
      }
    }
    check("c", badC.length === 0, `status/balance_due de ${invByTxn.size} factura(s) contra IsPaid/BalanceRemaining: ${badC.length} mismatch(es)`);
    showFirst(badC);

    // ── (d) aplicaciones ─────────────────────────────────────────────────
    const paymentIds = [...rpByTxn.values()].map((r) => String(r.id));
    const srPayByParent = new Map<string, Row[]>();
    for (const r of payRows) if (r.parent_txn != null && r.run_id === RUN_ID) {
      const k = String(r.parent_txn);
      srPayByParent.set(k, [...(srPayByParent.get(k) ?? []), r]);
    }
    const { rows: appRows } = await client.query<Row>(
      `SELECT payment_id, invoice_id, amount_applied FROM payment_application
        WHERE deleted_at IS NULL AND voided_at IS NULL AND payment_id = ANY($1::text[])`,
      [[...paymentIds, ...[...srPayByParent.values()].flat().map((r) => String(r.id))]]
    );
    const appliedByPayment = new Map<string, number>();
    for (const a of appRows) appliedByPayment.set(String(a.payment_id), (appliedByPayment.get(String(a.payment_id)) ?? 0) + cents(a.amount_applied));
    const { rows: knownInv } = await client.query<Row>(`SELECT metadata->>'qb_txn_id' AS t FROM pos_invoice WHERE deleted_at IS NULL AND metadata->>'qb_txn_id' IS NOT NULL`);
    const posInvoiceTxns = new Set(knownInv.map((r) => String(r.t)));
    const badD: string[] = [];
    let unlinked = 0;
    for (const [t, r] of rpByTxn) {
      const qb = qbRp.get(t);
      if (!qb) continue;
      let expected = 0;
      for (const a of qb.applied) {
        if (a.amount_cents <= 0) continue;
        if (a.txn_type === "Invoice" && posInvoiceTxns.has(a.txn_id)) expected += a.amount_cents;
        else unlinked++;
      }
      const got = appliedByPayment.get(String(r.id)) ?? 0;
      if (got !== expected) badD.push(`pago PAY-${r.display_id} (${t}): Σ aplicado ${got} ≠ Σ QB AppliedToTxn ${expected}`);
    }
    check("d", badD.length === 0, `Σ payment_application == Σ AppliedToTxn (facturas conocidas) en ${rpByTxn.size} pago(s): ${badD.length} mismatch(es)`);
    showFirst(badD);
    info("d", `aplicaciones a facturas que el POS no conoce: ${unlinked} (apply reportó ${report.unlinked_application.length})`);
    check("d", unlinked === report.unlinked_application.length, `unlinked_application: ${unlinked} == ${report.unlinked_application.length} del apply`);
    const badSr: string[] = [];
    for (const [t, r] of srByTxn) {
      const pays = srPayByParent.get(t) ?? [];
      if (pays.length !== 1) { badSr.push(`SR ${r.invoice_number} (${t}): ${pays.length} pago(s) embebido(s), se espera 1`); continue; }
      const pay = pays[0] as Row;
      const got = appliedByPayment.get(String(pay.id)) ?? 0;
      if (got !== cents(r.total) || cents(pay.amount) !== cents(r.total)) badSr.push(`SR ${r.invoice_number} (${t}): pago ${cents(pay.amount)} aplicado ${got} vs total ${cents(r.total)}`);
    }
    check("d", badSr.length === 0, `pago embebido de ${srByTxn.size} SR aplicado exactamente por su total: ${badSr.length} mismatch(es)`);
    showFirst(badSr);

    // ── (e) fechas ───────────────────────────────────────────────────────
    const badE: string[] = [];
    const txnDate = (t: string) => classDocs.get(t)?.txn_date;
    for (const [t, r] of [...invByTxn, ...srByTxn]) if (r.issued_date !== txnDate(t)) badE.push(`pos_invoice ${r.invoice_number} (${t}): issued ${r.issued_date} ≠ TxnDate ${txnDate(t)}`);
    for (const [t, r] of rpByTxn) if (r.received_date !== txnDate(t)) badE.push(`customer_payment PAY-${r.display_id} (${t}): received ${r.received_date} ≠ TxnDate ${txnDate(t)}`);
    for (const [t, r] of cmByTxn) if (r.completed_date !== txnDate(t)) badE.push(`pos_credit_memo ${r.credit_memo_number} (${t}): completed ${r.completed_date} ≠ TxnDate ${txnDate(t)}`);
    for (const [t, r] of orderByTxn) if (r.created_date !== txnDate(t)) badE.push(`order ${r.document_number} (${t}): created ${r.created_date} ≠ TxnDate ${txnDate(t)}`);
    check("e", badE.length === 0, `fechas (issued/received/completed/order.created ::date == TxnDate) en ${invByTxn.size + srByTxn.size + rpByTxn.size + cmByTxn.size + orderByTxn.size} documento(s): ${badE.length} mismatch(es)`);
    showFirst(badE);

    // ── (f) numeración ───────────────────────────────────────────────────
    const badF: string[] = [];
    const histOrders: { n: string; date: string; created: string }[] = [];
    for (const [t, r] of orderByTxn) {
      const hist = isHistoricalSalesDate(String(txnDate(t)));
      const n = String(r.document_number ?? "");
      if (/^S[0-9]{4}$/.test(n) !== hist) badF.push(`order ${n} (${t}, ${txnDate(t)}): numeración ${hist ? "histórica" : "corriente"} esperada`);
      if (hist) histOrders.push({ n, date: String(txnDate(t)), created: String(r.created_date) });
    }
    for (const [t, r] of [...invByTxn, ...srByTxn]) {
      const hist = isHistoricalSalesDate(String(txnDate(t)));
      if (/^0[0-9]{4}$/.test(String(r.invoice_number)) !== hist) badF.push(`pos_invoice ${r.invoice_number} (${t}, ${txnDate(t)}): numeración ${hist ? "histórica" : "corriente"} esperada`);
    }
    for (const [t, r] of cmByTxn) {
      const hist = isHistoricalSalesDate(String(txnDate(t)));
      if (/^CM-0[0-9]{3}$/.test(String(r.credit_memo_number)) !== hist) badF.push(`pos_credit_memo ${r.credit_memo_number} (${t}, ${txnDate(t)}): numeración ${hist ? "histórica" : "corriente"} esperada`);
    }
    histOrders.sort((a, b) => a.n.localeCompare(b.n));
    for (let i = 1; i < histOrders.length; i++) {
      const cur = histOrders[i] as (typeof histOrders)[number];
      const prev = histOrders[i - 1] as (typeof histOrders)[number];
      if (cur.created < prev.created) badF.push(`orden histórica ${cur.n} (${cur.created}) es anterior a ${prev.n} (${prev.created})`);
    }
    const dupOf = (vals: string[], label: string) => {
      const seen = new Map<string, number>();
      for (const v of vals) seen.set(v, (seen.get(v) ?? 0) + 1);
      for (const [v, n] of seen) if (n > 1) badF.push(`${label} ${v} duplicado ×${n}`);
    };
    dupOf([...orderByTxn.values()].map((r) => String(r.document_number)), "order.document_number");
    dupOf([...invByTxn.values(), ...srByTxn.values()].map((r) => String(r.invoice_number)), "pos_invoice.invoice_number");
    dupOf([...cmByTxn.values()].map((r) => String(r.credit_memo_number)), "pos_credit_memo.credit_memo_number");
    check("f", badF.length === 0 && histOrders.length > 0, `numeración: ${histOrders.length} orden(es) históricas cronológicas, rangos por fecha y sin duplicados: ${badF.length} problema(s)`);
    showFirst(badF);

    // ── (g) stock intacto ────────────────────────────────────────────────
    const { rows: stockRows } = await client.query<Row>(
      `SELECT COALESCE(sum(stocked_quantity),0)::text AS stocked, COALESCE(sum(reserved_quantity),0)::text AS reserved, count(*)::text AS n,
              (SELECT count(*) FROM reservation_item)::text AS reservations FROM inventory_level`
    );
    const snap = stockRows[0] as Row;
    let before: Row = STOCK_BEFORE_DEFAULT;
    if (STOCK_BEFORE && existsSync(STOCK_BEFORE)) before = JSON.parse(readFileSync(STOCK_BEFORE, "utf8")) as Row;
    else console.log(`  ⚠️  (g) sin --stock-before: se compara contra los literales medidos antes del run ${JSON.stringify(STOCK_BEFORE_DEFAULT)}`);
    const sameStock = (["stocked", "reserved", "n", "reservations"] as const).every((k) => before[k] == null || String(before[k]) === String(snap[k]));
    check("g", sameStock, `stock intacto: inventory_level ${snap.stocked}|${snap.reserved}|${snap.n} · reservation_item ${snap.reservations} (esperado ${before.stocked}|${before.reserved}|${before.n} · ${before.reservations ?? "—"})`);

    // ── (h) pipeline ─────────────────────────────────────────────────────
    const orderIds = [...orderByTxn.values()].map((r) => String(r.id));
    const { rows: dispatchable } = await client.query<Row>(
      `SELECT id, step, status FROM qb_order_pipeline
        WHERE status IN ('pending','submitted','waiting','processing')
          AND (payload->>'run_id' = $1 OR order_id = ANY($2::text[]) OR reference_id = ANY($3::text[]))`,
      [RUN_ID, orderIds, [...paymentIds, ...[...cmByTxn.values()].map((r) => String(r.id))]]
    );
    check("h", dispatchable.length === 0, `filas despachables de pipeline para el run: ${dispatchable.length}`);
    const { rows: seeds } = await client.query<Row>(
      `SELECT reference_id, step, status, qb_txn_id FROM qb_order_pipeline
        WHERE payload->>'run_id' = $1 AND step IN ('invoice','sales_receipt','payment','credit_memo')`,
      [RUN_ID]
    );
    const seedKey = new Map(seeds.map((s) => [`${s.step}:${s.reference_id}`, s]));
    const badH: string[] = [];
    const seedCheck = (step: string, byTxn: Map<string, Row>) => {
      for (const [t, r] of byTxn) {
        const s = seedKey.get(`${step}:${r.id}`);
        if (!s) badH.push(`${step} ${r.id} (${t}): sin fila de pipeline sembrada`);
        else if (s.status !== "confirmed" || s.qb_txn_id !== t) badH.push(`${step} ${r.id}: fila ${s.status} qb_txn_id ${s.qb_txn_id} ≠ ${t}`);
      }
    };
    seedCheck("invoice", invByTxn);
    seedCheck("sales_receipt", srByTxn);
    seedCheck("payment", rpByTxn);
    seedCheck("credit_memo", cmByTxn);
    check("h", badH.length === 0, `semilla confirmada con qb_txn_id correcto para ${invByTxn.size + srByTxn.size + rpByTxn.size + cmByTxn.size} documento(s): ${badH.length} falla(s)`);
    showFirst(badH);

    // ── (i) regla 2025 ───────────────────────────────────────────────────
    const badI: string[] = [];
    for (const [t, r] of srByTxn) if (String(txnDate(t)).startsWith("2025")) badI.push(`SR ${r.invoice_number} (${t}) fechado ${txnDate(t)}`);
    let inv2025 = 0;
    for (const [t, r] of invByTxn) {
      const d = classDocs.get(t) as QbInvoice | undefined;
      if (!d || !d.txn_date.startsWith("2025")) continue;
      inv2025++;
      if (!d.via_link && !unpaid2025.has(t)) badI.push(`invoice ${r.invoice_number} (${t}) fechada ${d.txn_date} sin via_link ni en impagas 2025`);
    }
    check("i", badI.length === 0, `regla 2025: 0 SR de 2025 y ${inv2025} factura(s) 2025 justificadas (via_link o impaga): ${badI.length} violación(es)`);
    showFirst(badI);

    // ── (j) identidad para el GL importer ────────────────────────────────
    const known = await loadPosKnownTxnIds(client);
    const sampleTxns = [invByTxn, srByTxn, rpByTxn, cmByTxn].flatMap((m) => [...m.keys()].slice(0, Math.ceil(SAMPLE / 4)));
    const unknown = sampleTxns.filter((t) => !known.has(t));
    check("j", unknown.length === 0 && sampleTxns.length > 0, `pos-links.ts (loadPosKnownTxnIds) reconoce ${sampleTxns.length - unknown.length}/${sampleTxns.length} TxnID muestreados como del POS`);
    showFirst(unknown);

    // ── (k) API ──────────────────────────────────────────────────────────
    const per = Math.ceil(SAMPLE / 3);
    const targets = [
      ...[...invByTxn.values(), ...srByTxn.values()].slice(0, per).map((r) => `/admin/invoices/${r.id}`),
      ...[...cmByTxn.values()].slice(0, per).map((r) => `/admin/pos/credit_memos/${r.id}`),
      ...[...rpByTxn.values()].slice(0, per).map((r) => `/admin/finance/payments/${r.id}`),
    ];
    try {
      const token = await fetchToken();
      const badK: string[] = [];
      for (const path of targets) {
        const res = await fetch(`${ADMIN_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status !== 200) badK.push(`GET ${path} → ${res.status}`);
      }
      check("k", badK.length === 0 && targets.length > 0, `${targets.length - badK.length}/${targets.length} GET muestreados responden 200`);
      showFirst(badK);
    } catch (err) {
      check("k", false, `no se pudo autenticar/consultar el admin en ${ADMIN_URL}: ${(err as Error).message}`);
    }

    // ── (l) fulfillment ──────────────────────────────────────────────────
    const noItems = [...orderByTxn.values()].filter((r) => Number(r.n_items) === 0);
    const unfulfilled = [...orderByTxn.values()].filter((r) => Number(r.n_items) > 0 && Number(r.live_fulfillments) === 0);
    info("l", `órdenes sin ítems (rechazadas por fulfill-backfilled-qb-orders "no tiene ítems"): ${noItems.length} — ${noItems.map((r) => r.document_number).join(", ")}`);
    if (SKIP_FULFILLMENT) info("l", `--skip-fulfillment: ${unfulfilled.length} orden(es) con ítems sin fulfillment vivo (no se afirma)`);
    else {
      check("l", unfulfilled.length === 0, `${orderByTxn.size - noItems.length - unfulfilled.length}/${orderByTxn.size - noItems.length} orden(es) con ítems tienen fulfillment vivo`);
      showFirst(unfulfilled.map((r) => `order ${r.document_number} (${r.marker_txn}) sin fulfillment`));
    }

    // ── (m) no-vacuidad ──────────────────────────────────────────────────
    check("m", invByTxn.size > 0 && srByTxn.size > 0 && rpByTxn.size > 0 && cmByTxn.size > 0, `created > 0 en los 4 tipos: invoices ${invByTxn.size} · SR ${srByTxn.size} · pagos ${rpByTxn.size} · CM ${cmByTxn.size}`);

    // ── (n) aplicaciones de credit memos a facturas ──────────────────────
    const { rows: cmAppRows } = await client.query<Row>(
      `SELECT cp.metadata->>'qb_txn_id' AS cm_txn, pa.invoice_id, pa.amount_applied
         FROM payment_application pa JOIN customer_payment cp ON cp.id = pa.payment_id AND cp.deleted_at IS NULL
        WHERE pa.deleted_at IS NULL AND pa.voided_at IS NULL AND cp.type = 'credit_memo' AND pa.invoice_id IS NOT NULL`
    );
    const cmApplied = new Map<string, number>();
    for (const r of cmAppRows) cmApplied.set(`${r.cm_txn}\t${r.invoice_id}`, (cmApplied.get(`${r.cm_txn}\t${r.invoice_id}`) ?? 0) + cents(r.amount_applied));
    const badN: string[] = [];
    let nLinks = 0;
    let nUnknown = 0;
    for (const [t, r] of cmByTxn) {
      const qb = qbCm.get(t);
      if (!qb) continue;
      for (const l of qb.linked_txns) {
        if (l.txn_type !== "Invoice" || (l.amount_cents ?? 0) >= 0) continue;
        const found = await findPosInvoiceByQbTxnId(client, l.txn_id);
        if (!found) { nUnknown++; continue; }
        nLinks++;
        const got = cmApplied.get(`${t}\t${found.invoice_id}`);
        const want = Math.abs(l.amount_cents ?? 0);
        if (got !== want) badN.push(`CM ${r.credit_memo_number} (${t}) → INV-${found.invoice_number}: aplicado ${got ?? "—"} ≠ |QB| ${want}`);
      }
    }
    check("n", badN.length === 0 && nLinks > 0, `aplicaciones CM→factura: ${nLinks - badN.length}/${nLinks} enlaces negativos con factura conocida tienen payment_application de pago credit_memo por |Amount| (${nUnknown} a facturas desconocidas)`);
    showFirst(badN);
    // (n2) facturas paid sin aplicación == las que QB no cobra por ReceivePayment ni CM (en la caché)
    const { rows: noAppRows } = await client.query<Row>(
      `SELECT i.invoice_number, i.total, i.metadata->>'qb_txn_id' AS txn_id FROM pos_invoice i
        WHERE i.deleted_at IS NULL AND i.metadata->'qb_backfill'->>'run_id' = $1 AND i.status = 'paid' AND i.total > 0
          AND coalesce(i.metadata->>'is_sales_receipt','false') <> 'true'
          AND NOT EXISTS (SELECT 1 FROM payment_application pa WHERE pa.invoice_id = i.id AND pa.deleted_at IS NULL AND pa.voided_at IS NULL)
        ORDER BY i.invoice_number`,
      [RUN_ID]
    );
    const paidByQb = new Set<string>();
    for (const rp of qbRp.values()) for (const a of rp.applied) if (a.txn_type === "Invoice" && a.amount_cents > 0) paidByQb.add(a.txn_id);
    for (const c of qbCm.values()) for (const l of c.linked_txns) if (l.txn_type === "Invoice" && (l.amount_cents ?? 0) < 0) paidByQb.add(l.txn_id);
    const noApp = noAppRows.map((r) => String(r.txn_id));
    const noQbSource = noApp.filter((t) => !paidByQb.has(t));
    const withQbSource = noAppRows.filter((r) => paidByQb.has(String(r.txn_id)));
    check("n2", noApp.length === noQbSource.length, `facturas paid (total > 0) sin aplicación: ${noApp.length} == ${noQbSource.length} sin ReceivePayment ni CM en la caché QB`);
    showFirst(withQbSource.map((r) => `invoice ${r.invoice_number} (${r.txn_id}) paid sin aplicación pero QB la cobra`));
    info("n2", `sin fuente en QB (pago posterior a la ventana o refund): ${noAppRows.filter((r) => !paidByQb.has(String(r.txn_id))).map((r) => `INV-${r.invoice_number} $${(cents(r.total) / 100).toFixed(2)}`).join(", ") || "—"}`);
  } finally {
    client.release();
    await pool.end();
  }

  console.log(failures === 0 ? "\n✅ verify-qb-sales-backfill: todo verde" : `\n✗ verify-qb-sales-backfill: ${failures} fallo(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
