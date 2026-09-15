/**
 * diff-qb-ar-ap — ¿qué documentos explican la diferencia QB−POS de Accounts Receivable
 * y Accounts Payable? (plan arap-parity-20260915). SÓLO LECTURA.
 *
 *   DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/ledger/diff-qb-ar-ap.ts \
 *     [--from 2026-01-01] [--to 2026-09-15] [--cache-dir .qb-gl-cache] [--out docs/AR_AP_DIFF.md]
 *
 * Lado QB: las ventanas del reporte General Ledger ya cacheadas por
 * `import-qb-general-ledger` (`gl_<from>_<to>.json`). Para cada DÍA se toma UNA sola
 * ventana (la de mtime más reciente que lo cubre): dos ventanas solapadas nunca
 * cuentan dos veces. Borrar la caché de un mes y correr el importer en dry-run la
 * refresca. Lado POS: líneas del libro sobre la cuenta, resueltas a TxnID.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { parseGeneralLedgerReport } from "../../lib/ledger/qb-import";
import { diffControlAccount, renderDiff, type PosContribution, type QbContribution } from "../../lib/ledger/qb-import/ar-ap-diff";

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const FROM = flag("--from", "2026-01-01"), TO = flag("--to", "2026-09-15");
const CACHE = flag("--cache-dir", join(process.cwd(), ".qb-gl-cache"));
const OUT = flag("--out", join(process.cwd(), ".qb-gl-cache", `ar-ap-diff_${FROM}_${TO}.md`));
const ACCOUNTS = ["Accounts Receivable", "Accounts Payable"];

/** día → archivo de ventana que lo cubre (mtime más reciente gana). */
function windowByDay(): Map<string, string> {
  const files = readdirSync(CACHE).filter((f) => /^gl_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => { const [from, to] = f.replace("gl_", "").replace(".json", "").split("_") as [string, string]; return { f, from, to, mtime: statSync(join(CACHE, f)).mtimeMs }; })
    .sort((a, b) => a.mtime - b.mtime);
  const byDay = new Map<string, string>();
  for (const w of files) {
    for (let d = new Date(`${w.from}T00:00:00Z`); d.toISOString().slice(0, 10) <= w.to; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = d.toISOString().slice(0, 10);
      if (day >= FROM && day <= TO) byDay.set(day, w.f);
    }
  }
  return byDay;
}

function loadQb(): { rows: Map<string, QbContribution[]>; missingDays: string[] } {
  const byDay = windowByDay();
  const rows = new Map<string, QbContribution[]>(ACCOUNTS.map((a) => [a, []]));
  const parsed = new Map<string, ReturnType<typeof parseGeneralLedgerReport>>();
  const missing: string[] = [];
  for (let d = new Date(`${FROM}T00:00:00Z`); d.toISOString().slice(0, 10) <= TO; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    const f = byDay.get(day);
    if (!f) { missing.push(day); continue; }
    if (!parsed.has(f)) {
      const raw = JSON.parse(readFileSync(join(CACHE, f), "utf8"));
      const ret = raw?.operation?.result?.QBXML?.QBXMLMsgsRs?.GeneralDetailReportQueryRs?.ReportRet ?? raw?.ReportRet ?? raw;
      const [from, to] = f.replace("gl_", "").replace(".json", "").split("_") as [string, string];
      parsed.set(f, parseGeneralLedgerReport(ret, from, to));
    }
    for (const r of parsed.get(f)!.rows) {
      if (r.date !== day || !ACCOUNTS.includes(r.account) || !r.txn_id) continue;
      rows.get(r.account)!.push({ txn_id: r.txn_id, txn_type: r.txn_type, date: r.date, ref_number: r.ref_number, name: r.name, cents: r.debit_cents - r.credit_cents });
    }
  }
  return { rows, missingDays: missing };
}

async function loadPos(client: PoolClient, account: string): Promise<PosContribution[]> {
  const { rows } = await client.query<{ entry_id: string; source_kind: string; source_id: string; document_number: string | null; day: string; txn_id: string | null; cents: string }>(
    `SELECT e.id AS entry_id, e.source_kind, e.source_id, e.document_number, e.day,
            CASE e.source_kind
              WHEN 'qb_import' THEN e.source_id
              WHEN 'pos_invoice' THEN (SELECT metadata->>'qb_txn_id' FROM pos_invoice WHERE id = e.source_id)
              WHEN 'customer_payment' THEN (SELECT metadata->>'qb_txn_id' FROM customer_payment WHERE id = e.source_id)
              WHEN 'pos_credit_memo' THEN (SELECT qb_txn_id FROM pos_credit_memo WHERE id = e.source_id)
              WHEN 'vendor_bill' THEN (SELECT qb_txn_id FROM vendor_bill WHERE id = e.source_id)
              WHEN 'vendor_credit' THEN (SELECT qb_txn_id FROM vendor_credit WHERE id = e.source_id)
              WHEN 'vendor_bill_payment' THEN (SELECT qb_txn_id FROM vendor_bill_payment WHERE id = e.source_id)
              WHEN 'po_receipt' THEN (SELECT qb_item_receipt_list_id FROM purchase_order_receipt WHERE id = e.source_id)
              WHEN 'bank_check' THEN (SELECT qb_txn_id FROM gl_check WHERE id = e.source_id)
              WHEN 'bank_transfer' THEN (SELECT qb_txn_id FROM gl_transfer WHERE id = e.source_id)
              WHEN 'journal_entry' THEN (SELECT qb_txn_id FROM gl_journal_entry WHERE id = e.source_id)
              WHEN 'bank_deposit' THEN (SELECT qb_txn_id FROM bank_deposit WHERE id = e.source_id)
              ELSE NULL END AS txn_id,
            sum(l.debit_cents - l.credit_cents)::text AS cents
       FROM bank_journal_line l JOIN bank_journal_entry e ON e.id = l.entry_id JOIN qb_account a ON a.qb_list_id = l.account_list_id
      WHERE a.full_name = $1 AND e.kind = 'document' AND e.day >= $2 AND e.day <= $3
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
      GROUP BY e.id, e.source_kind, e.source_id, e.document_number, e.day`,
    [account, FROM, TO]
  );
  return rows.map((r) => ({ ...r, cents: BigInt(r.cents) }));
}

async function main(): Promise<void> {
  const { rows: qb, missingDays } = loadQb();
  const client = await getDbPool().connect();
  const out: string[] = [`# AR/AP QB vs POS — ${FROM}..${TO}`, "", `Caché GL: ${CACHE} · días sin ventana: ${missingDays.length}${missingDays.length ? ` (${missingDays.slice(0, 5).join(", ")}…)` : ""}`, ""];
  try {
    for (const account of ACCOUNTS) {
      const pos = await loadPos(client, account);
      const r = diffControlAccount(qb.get(account)!, pos);
      out.push(...renderDiff(account, r), "");
    }
  } finally {
    client.release();
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out.join("\n"));
  console.log(out.filter((l) => !l.startsWith("| 2026-") || l.includes("mes")).join("\n"));
  console.log(`\nreporte: ${OUT}`);
}

main().then(() => process.exit(0)).catch((e: unknown) => { console.error("diff-qb-ar-ap:", e instanceof Error ? e.message : e); process.exit(1); });
