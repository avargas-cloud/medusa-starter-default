/**
 * backfill-qb-sales — plan `qb-sales-backfill-20260911`, fases 1-2 (descarga
 * + clasificación).
 *
 *   DATABASE_URL=… QB_BRIDGE_URL=… QB_API_KEY=… ECOPOWERTECH_ENV=sandbox \
 *   ./node_modules/.bin/tsx src/scripts/sync/backfill-qb-sales.ts \
 *     --from 2026-01-01 --to 2026-09-08 --types invoice,sales_receipt,receive_payment,credit_memo \
 *     [--unpaid-2025] [--cache-dir .qb-docs-cache] [--pause-ms 10000] [--run-id qbsb-…]
 *     [--no-follow-links] [--cache-only]
 *
 * Fase 1: descarga (o lee de caché) los 4 requests QBXML por ventana MENSUAL,
 * normaliza y reporta conteos por tipo/mes. `--unpaid-2025` agrega
 * `InvoiceQueryRq`/`BillQueryRq` con `PaidStatus=NotPaidOnly` sobre 2025
 * (lo abierto al cierre que NADIE pagó todavía, invisible por enlace).
 *
 * Después de la descarga (por default, `--no-follow-links` lo salta): sigue
 * enlaces 2025 (`sales-follow-links.ts`) y clasifica contra el POS
 * (`sales-classify.ts`) usando `DATABASE_URL` — SÓLO LECTURA, nada se crea
 * acá (fase 3/4 en otro executor). El resultado se escribe a
 * `.qb-docs-cache/sales-classification_<run-id>.json`.
 *
 * `--cache-only`: ninguna ventana/ventana-por-enlace SIN caché toca el bridge
 * — se salta y se reporta como pendiente (uso: correr contra lo que otro
 * proceso ya bajó, sin competir por el mismo bridge).
 *
 * QuickBooks SÓLO se lee (`*QueryRq`). La creación (fase 3/4) vive en otro
 * módulo, fuera de este driver.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { directQuery, cachePathFor } from "../../lib/qb-backfill/qb-client";
import {
  buildInvoiceQbxml,
  buildSalesReceiptQbxml,
  buildReceivePaymentQbxml,
  buildCreditMemoQbxml,
  buildInvoiceUnpaidQbxml,
  buildBillUnpaidQbxml,
  monthlyWindows,
} from "../../lib/qb-backfill/sales-queries";
import {
  normalizeInvoices,
  normalizeSalesReceipts,
  normalizeReceivePayments,
  normalizeCreditMemos,
} from "../../lib/qb-backfill/sales-normalize";
import { normalizeBills } from "../../lib/qb-backfill/normalize";
import { followSalesLinks } from "../../lib/qb-backfill/sales-follow-links";
import { classifySalesBucket } from "../../lib/qb-backfill/sales-classify";
import { loadItemIndex } from "../../lib/qb-backfill/resolve";
import { loadCustomerIndex, loadKnownSalesTxnIds } from "../../lib/qb-backfill/sales-resolve";
import { printSalesClassificationReport } from "../../lib/qb-backfill/sales-report";
import type { QbSalesBucket, QbSalesDocType } from "../../lib/qb-backfill/sales-types";
import type { QbBill } from "../../lib/qb-backfill/types";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : def;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FROM = arg("from");
const TO = arg("to");
const CACHE_DIR = arg("cache-dir", ".qb-docs-cache") as string;
const PAUSE_MS = Number(arg("pause-ms", "10000"));
const UNPAID_2025 = flag("unpaid-2025");
const FOLLOW_LINKS = !flag("no-follow-links");
const CACHE_ONLY = flag("cache-only");
const RUN_ID = arg("run-id", `qbsb-${new Date().toISOString().slice(0, 10)}`) as string;
const TYPES = new Set<QbSalesDocType>(
  (arg("types", "invoice,sales_receipt,receive_payment,credit_memo") as string)
    .split(",")
    .map((s) => s.trim() as QbSalesDocType)
);

if (!FROM || !TO) {
  console.error(
    "uso: --from YYYY-MM-DD --to YYYY-MM-DD [--types …] [--unpaid-2025] [--cache-dir DIR] [--pause-ms N] [--run-id ID] [--no-follow-links] [--cache-only]"
  );
  process.exit(2);
}

/** `true` = se saltea (sin caché y `--cache-only`); loguea y devuelve `null` en vez de fetchear. */
async function cacheOnlyGuardedQuery(
  qbxml: string,
  rsKey: string,
  key: string,
  log: (s: string) => void
): Promise<{ rs: Record<string, unknown> | null; cached: boolean; skipped: boolean }> {
  const path = cachePathFor(CACHE_DIR, key);
  if (CACHE_ONLY && !existsSync(path)) {
    log(`  [cache-only] ${key}: sin caché — SALTEADO (no se llamó al bridge)`);
    return { rs: null, cached: false, skipped: true };
  }
  const { rs, cached } = await directQuery(qbxml, rsKey, { cacheDir: CACHE_DIR, cacheKey: key, log });
  return { rs, cached, skipped: false };
}

export type SalesDownload = QbSalesBucket & {
  unpaid_invoices_2025: QbSalesBucket["invoices"];
  unpaid_bills_2025: QbBill[];
  /** Ventanas/consultas salteadas por `--cache-only` (sin caché) — el caller decide si eso invalida la clasificación. */
  skipped_keys: string[];
};

/** Descarga por ventana mensual; cada request se cachea por clave y nunca se re-pide. `--cache-only` saltea lo que falte. */
export async function downloadSales(from: string, to: string, log: (s: string) => void): Promise<SalesDownload> {
  const bucket: SalesDownload = {
    invoices: [],
    sales_receipts: [],
    receive_payments: [],
    credit_memos: [],
    unpaid_invoices_2025: [],
    unpaid_bills_2025: [],
    skipped_keys: [],
  };
  const windows = [...monthlyWindows(from, to)];
  log(`${windows.length} ventana(s) mensual(es) · tipos: ${[...TYPES].join(",")}${CACHE_ONLY ? " · CACHE-ONLY" : ""}`);

  const steps: Array<{
    type: QbSalesDocType;
    prefix: string;
    rsKey: string;
    build: (f: string, t: string) => string;
    push: (rs: Record<string, unknown> | null) => number;
  }> = [
    { type: "invoice", prefix: "invoice", rsKey: "InvoiceQueryRs", build: buildInvoiceQbxml, push: (rs) => bucket.invoices.push(...normalizeInvoices(rs)) },
    { type: "sales_receipt", prefix: "salesreceipt", rsKey: "SalesReceiptQueryRs", build: buildSalesReceiptQbxml, push: (rs) => bucket.sales_receipts.push(...normalizeSalesReceipts(rs)) },
    { type: "receive_payment", prefix: "receivepayment", rsKey: "ReceivePaymentQueryRs", build: buildReceivePaymentQbxml, push: (rs) => bucket.receive_payments.push(...normalizeReceivePayments(rs)) },
    { type: "credit_memo", prefix: "creditmemo", rsKey: "CreditMemoQueryRs", build: buildCreditMemoQbxml, push: (rs) => bucket.credit_memos.push(...normalizeCreditMemos(rs)) },
  ];

  for (const w of windows) {
    const label = `${w.from}..${w.to}`;
    for (const s of steps) {
      if (!TYPES.has(s.type)) continue;
      const key = `${s.prefix}_${w.from}_${w.to}`;
      const before = bucketSize(bucket);
      const { rs, cached: hit, skipped } = await cacheOnlyGuardedQuery(s.build(w.from, w.to), s.rsKey, key, log);
      if (skipped) {
        bucket.skipped_keys.push(key);
        continue;
      }
      s.push(rs);
      log(`  [${s.type}] ${label}${hit ? " (caché)" : ""}: ${bucketSize(bucket) - before} · ${cachePathFor(CACHE_DIR, key)}`);
      if (!hit && PAUSE_MS > 0) await sleep(PAUSE_MS);
    }
  }

  if (UNPAID_2025) {
    const key = "invoice_unpaid_2025-01-01_2025-12-31";
    const inv = await cacheOnlyGuardedQuery(buildInvoiceUnpaidQbxml("2025-01-01", "2025-12-31"), "InvoiceQueryRs", key, log);
    if (inv.skipped) {
      bucket.skipped_keys.push(key);
    } else {
      bucket.unpaid_invoices_2025 = normalizeInvoices(inv.rs);
      log(`  [invoice NotPaidOnly 2025]${inv.cached ? " (caché)" : ""}: ${bucket.unpaid_invoices_2025.length}`);
      if (!inv.cached && PAUSE_MS > 0) await sleep(PAUSE_MS);
    }
    const keyB = "bill_unpaid_2025-01-01_2025-12-31";
    const b = await cacheOnlyGuardedQuery(buildBillUnpaidQbxml("2025-01-01", "2025-12-31"), "BillQueryRs", keyB, log);
    if (b.skipped) {
      bucket.skipped_keys.push(keyB);
    } else {
      bucket.unpaid_bills_2025 = normalizeBills(b.rs);
      log(`  [bill NotPaidOnly 2025]${b.cached ? " (caché)" : ""}: ${bucket.unpaid_bills_2025.length}`);
    }
  }
  return bucket;
}

function bucketSize(b: QbSalesBucket): number {
  return b.invoices.length + b.sales_receipts.length + b.receive_payments.length + b.credit_memos.length;
}

function byMonth<T extends { txn_date: string }>(docs: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of docs) {
    const m = d.txn_date.slice(0, 7);
    out[m] = (out[m] ?? 0) + 1;
  }
  return out;
}

async function main(): Promise<void> {
  const log = (s: string) => console.log(s);
  const t0 = Date.now();
  console.log(`backfill-qb-sales ${FROM}..${TO} · run ${RUN_ID}${CACHE_ONLY ? " · CACHE-ONLY" : ""}`);
  const b = await downloadSales(FROM as string, TO as string, log);
  console.log(`\n── resumen descarga (${Math.round((Date.now() - t0) / 1000)} s) ──`);
  console.log(`invoices ${b.invoices.length} · sales receipts ${b.sales_receipts.length} · pagos ${b.receive_payments.length} · credit memos ${b.credit_memos.length}`);
  console.log(`por mes → invoices ${JSON.stringify(byMonth(b.invoices))}`);
  console.log(`         sales receipts ${JSON.stringify(byMonth(b.sales_receipts))}`);
  console.log(`         pagos ${JSON.stringify(byMonth(b.receive_payments))}`);
  console.log(`         credit memos ${JSON.stringify(byMonth(b.credit_memos))}`);
  if (UNPAID_2025) {
    console.log(`2025 impagos hoy → invoices ${b.unpaid_invoices_2025.length} · bills ${b.unpaid_bills_2025.length}`);
  }
  if (b.skipped_keys.length) {
    console.log(`\n[cache-only] ${b.skipped_keys.length} clave(s) salteada(s) por falta de caché: ${b.skipped_keys.slice(0, 20).join(", ")}${b.skipped_keys.length > 20 ? " …" : ""}`);
  }

  if (FOLLOW_LINKS) {
    console.log(`\n── follow-links (2025 por enlace) ──`);
    const flReport = await followSalesLinks(b, { floorDate: "2026-01-01", cacheDir: CACHE_DIR, pauseMs: PAUSE_MS, log });
    console.log(
      `followSalesLinks: ${flReport.iterations} iteración(es) · traídos por enlace: invoice ${flReport.fetched_by_type.invoices} · credit ${flReport.fetched_by_type.credit_memos}`
    );
    console.log(`  por año: ${JSON.stringify(flReport.fetched_by_year)}`);
  } else {
    console.log(`\n(--no-follow-links: se saltea 2025 por enlace)`);
  }

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("DATABASE_URL requerido para clasificar (fase 2) — abortando antes de tocar la DB.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    const [known, customerIndex, itemIndex] = await Promise.all([
      loadKnownSalesTxnIds(client),
      loadCustomerIndex(client),
      loadItemIndex(client),
    ]);
    const classification = classifySalesBucket(
      { invoices: b.invoices, sales_receipts: b.sales_receipts, payments: b.receive_payments, credit_memos: b.credit_memos },
      known,
      { toDate: TO as string, unpaidInvoiceTxnIds: new Set(b.unpaid_invoices_2025.map((i) => i.txn_id)) }
    );
    printSalesClassificationReport(log, classification, customerIndex, itemIndex);

    mkdirSync(CACHE_DIR, { recursive: true });
    const outPath = `${CACHE_DIR}/sales-classification_${RUN_ID}.json`;
    writeFileSync(outPath, JSON.stringify(classification, null, 2));
    console.log(`\nClasificación escrita en ${outPath}`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
