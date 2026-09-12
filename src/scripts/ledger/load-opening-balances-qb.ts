/**
 * load-opening-balances-qb — carga los saldos de apertura al 2025-12-31 desde
 * el Balance Sheet de QuickBooks (GeneralSummaryReportQueryRq
 * BalanceSheetStandard, bajado por el bridge a JSON) como documentos
 * `opening_balance` del libro (Banking-on-GL §2), uno por cuenta.
 *
 *   DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/ledger/load-opening-balances-qb.ts \
 *     --report ~/webapps/handoff-bankgl-20260911/qb-balance-sheet_2025-12-31.json \
 *     --evidence ~/webapps/handoff-bankgl-20260911/qb-balance-sheet_2025-12-31.pdf [--apply]
 *
 * `--evidence` es el mismo Balance Sheet en PDF (el documento `opening_balance`
 * exige evidencia — `bank_opening_evidence`, sólo PDF). Se registra UNA vez
 * (reuso por sha256) y las 50+ aperturas la comparten.
 *
 * Reglas:
 * - Cada hoja del reporte se mapea a UNA cuenta de `qb_account` por su ruta
 *   (`Padre:Hija`); "X - Other" es el saldo propio del padre X. Ambigüedad →
 *   se elige por el tipo de la sección del reporte (Credit Cards → CreditCard);
 *   si sigue ambigua, el script se niega.
 * - `Opening Balance Equity` NO se carga: es la contrapartida de todos los
 *   demás y queda con su saldo por construcción (Σ activos − Σ pasivos y
 *   patrimonio = su saldo en QB). El script lo afirma en el dry-run.
 * - `Net Income` (fila del reporte, no cuenta) se suma a `Retained Earnings`.
 * - Saldos negativos = cuenta contra su dirección normal (depreciación,
 *   AP deudor…): `buildOpeningBalanceLines` los postea del lado opuesto.
 * - Idempotente: `postOpeningBalance` devuelve `already_posted` si la cuenta
 *   ya tiene su OBE activo.
 * - `--apply` en producción exige `--target-production` + ECOPOWERTECH_ENV=production
 *   + CONFIRM_PRODUCTION_RUN=<run id> + el reporte del dry-run previo (target-guard).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { Pool } from "pg";

import { postOpeningBalance } from "../../lib/ledger/documents/opening-balance";
import { addOpeningBalanceEvidence } from "../../lib/ledger/opening-evidence";
import { assertDryRunEvidence, readJsonFile, resolveWriteTarget } from "../../lib/qb-backfill/target-guard";

const TAG = "load-opening-balances-qb";
const DAY = "2025-12-31";
const RUN_ID = `obe-${DAY}`;
const DRY_RUN_REPORT = `.qb-gl-cache/${TAG}_${RUN_ID}-dryrun.json`;
const ACTOR = "qb-balance-sheet-import";

const SECTION_TYPES: Record<string, string[]> = {
  "Checking/Savings": ["Bank"],
  "Accounts Receivable": ["AccountsReceivable"],
  "Other Current Assets": ["OtherCurrentAsset"],
  "Fixed Assets": ["FixedAsset"],
  "Other Assets": ["OtherAsset"],
  "Accounts Payable": ["AccountsPayable"],
  "Credit Cards": ["CreditCard"],
  "Other Current Liabilities": ["OtherCurrentLiability"],
  "Long Term Liabilities": ["LongTermLiability"],
  Equity: ["Equity"],
};
const REPORT_SECTIONS = new Set([
  "ASSETS", "Current Assets", "Fixed Assets", "Other Assets", "LIABILITIES & EQUITY", "Liabilities",
  "Current Liabilities", "Long Term Liabilities", "Equity", ...Object.keys(SECTION_TYPES),
]);

type ReportRow = { n: number; kind: "text" | "data" | "subtotal" | "total"; name: string; value: number | null };
type AccountRow = { qb_list_id: string; full_name: string; account_type: string; normal_balance: string | null };
type Plan = { list_id: string; full_name: string; account_type: string; balance_cents: bigint; source_rows: string[] };

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

function cents(v: number): bigint {
  return BigInt(Math.round(v * 100));
}

function flattenReport(report: unknown): ReportRow[] {
  const data = (report as { ReportData?: Record<string, unknown> }).ReportData ?? {};
  const out: ReportRow[] = [];
  const kinds: Array<[string, ReportRow["kind"]]> = [
    ["TextRow", "text"], ["DataRow", "data"], ["SubtotalRow", "subtotal"], ["TotalRow", "total"],
  ];
  for (const [key, kind] of kinds) {
    const raw = data[key];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const r of list as Array<Record<string, unknown>>) {
      const attrs = r.$ as { rowNumber: string; value?: string };
      const n = Number(attrs.rowNumber);
      if (kind === "text") {
        out.push({ n, kind, name: attrs.value ?? "", value: null });
        continue;
      }
      const cd = r.ColData;
      const cols = (Array.isArray(cd) ? cd : cd ? [cd] : []) as Array<{ $: { value?: string } }>;
      const name = cols[0]?.$.value ?? "";
      const value = cols[1]?.$.value;
      out.push({ n, kind, name, value: value === undefined ? null : Number(value) });
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

function resolveAccount(
  leaf: string,
  isOther: boolean,
  parents: string[],
  section: string | null,
  accounts: AccountRow[]
): AccountRow {
  let cands = accounts.filter((a) => a.full_name.split(":").pop() === leaf);
  if (cands.length > 1 && section && SECTION_TYPES[section]) {
    const byType = cands.filter((a) => SECTION_TYPES[section]!.includes(a.account_type));
    if (byType.length) cands = byType;
  }
  if (cands.length > 1) {
    // "X - Other" is X itself → its parent is parents[-2]; a leaf's parent is parents[-1].
    const parent = isOther ? parents[parents.length - 2] : parents[parents.length - 1];
    const byParent = cands.filter((a) => {
      const path = a.full_name.split(":");
      return parent ? path[path.length - 2] === parent : path.length === 1;
    });
    if (byParent.length) cands = byParent;
  }
  if (cands.length !== 1) {
    throw new Error(
      `[${TAG}] cuenta ambigua o ausente para '${leaf}' (sección ${section ?? "?"}, padres ${parents.join(" > ") || "—"}): ` +
        (cands.map((c) => c.full_name).join(" | ") || "sin candidatos")
    );
  }
  return cands[0]!;
}

function buildPlan(rows: ReportRow[], accounts: AccountRow[]): { plans: Plan[]; obeInReport: bigint; netIncome: bigint } {
  const stack: string[] = [];
  const plans = new Map<string, Plan>();
  let obeInReport = 0n;
  let netIncome = 0n;
  let retained: Plan | null = null;
  for (const r of rows) {
    if (r.kind === "text") {
      stack.push(r.name);
      continue;
    }
    if (r.kind === "subtotal" || r.kind === "total") {
      if (stack.length && r.name === `Total ${stack[stack.length - 1]}`) stack.pop();
      continue;
    }
    const value = r.value ?? 0;
    if (r.name === "Net Income") {
      netIncome = cents(value);
      continue;
    }
    if (r.name === "Opening Balance Equity") {
      obeInReport = cents(value);
      continue;
    }
    const isOther = r.name.endsWith(" - Other");
    const leaf = isOther ? r.name.slice(0, -" - Other".length) : r.name;
    const parents = stack.filter((s) => !REPORT_SECTIONS.has(s));
    const section = [...stack].reverse().find((s) => SECTION_TYPES[s]) ?? null;
    const acct = resolveAccount(leaf, isOther, parents, section, accounts);
    const existing = plans.get(acct.qb_list_id);
    const plan: Plan = existing ?? {
      list_id: acct.qb_list_id, full_name: acct.full_name, account_type: acct.account_type, balance_cents: 0n, source_rows: [],
    };
    plan.balance_cents += cents(value);
    plan.source_rows.push(`${r.name}=${value}`);
    plans.set(acct.qb_list_id, plan);
    if (acct.full_name === "Retained Earnings") retained = plan;
  }
  if (!retained) throw new Error(`[${TAG}] el reporte no trae Retained Earnings`);
  retained.balance_cents += netIncome;
  retained.source_rows.push(`Net Income=${Number(netIncome) / 100}`);
  return { plans: [...plans.values()], obeInReport, netIncome };
}

const DEBIT_TYPES = new Set(["Bank", "AccountsReceivable", "OtherCurrentAsset", "FixedAsset", "OtherAsset"]);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const reportPath = arg("report");
  const evidencePath = arg("evidence");
  if (!url || !reportPath || !evidencePath) throw new Error(`[${TAG}] DATABASE_URL, --report y --evidence son obligatorios`);
  const evidenceBytes = readFileSync(evidencePath);
  const evidenceSha = createHash("sha256").update(evidenceBytes).digest("hex");
  const apply = process.argv.includes("--apply");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
  const rows = flattenReport(report);

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const { rows: accounts } = await client.query<AccountRow>(
      `SELECT qb_list_id, full_name, account_type, normal_balance FROM qb_account WHERE deleted_at IS NULL AND is_active = true`
    );
    const { plans, obeInReport, netIncome } = buildPlan(rows, accounts);
    const nonZero = plans.filter((p) => p.balance_cents !== 0n);
    // Identidad: Σ débito-normal − Σ crédito-normal (sin OBE) == saldo del OBE en QB.
    let debits = 0n;
    let credits = 0n;
    for (const p of nonZero) (DEBIT_TYPES.has(p.account_type) ? (debits += p.balance_cents) : (credits += p.balance_cents));
    const implied = debits - credits;
    const money = (c: bigint) => (Number(c) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
    console.log(`\n[${TAG}] ${apply ? "APPLY" : "DRY-RUN"} · día ${DAY} · reporte ${reportPath} · evidencia ${basename(evidencePath)} (${evidenceBytes.length} bytes, sha256 ${evidenceSha.slice(0, 16)}…)`);
    console.log(`  cuentas con saldo: ${nonZero.length} (de ${plans.length}) · Net Income 2025 → Retained Earnings: ${money(netIncome)}`);
    console.log(`  Σ activos ${money(debits)} − Σ pasivos+patrimonio ${money(credits)} = ${money(implied)} · OBE en QB ${money(obeInReport)}`);
    if (implied !== obeInReport) throw new Error(`[${TAG}] el balance no cuadra contra Opening Balance Equity — no se carga nada`);
    for (const p of nonZero) {
      console.log(`  ${p.list_id.padEnd(22)} ${p.full_name.slice(0, 50).padEnd(50)} ${money(p.balance_cents).padStart(16)}  [${p.source_rows.join("; ")}]`);
    }

    if (!apply) {
      mkdirSync(".qb-gl-cache", { recursive: true });
      writeFileSync(
        DRY_RUN_REPORT,
        JSON.stringify(
          { run_id: RUN_ID, day: DAY, accounts: nonZero.length, debits: debits.toString(), credits: credits.toString(), obe: obeInReport.toString(),
            plans: nonZero.map((p) => ({ ...p, balance_cents: p.balance_cents.toString() })) },
          null, 2
        )
      );
      console.log(`\n  reporte: ${DRY_RUN_REPORT} · para aplicar: --apply`);
      return;
    }

    const target = resolveWriteTarget({ argv: process.argv, env: process.env, databaseUrl: url, runId: RUN_ID });
    console.log(`  destino: ${target.target} (${target.reason})`);
    const dry = existsSync(DRY_RUN_REPORT) ? readJsonFile<Record<string, number | string>>(DRY_RUN_REPORT) : null;
    assertDryRunEvidence(
      target.target, RUN_ID,
      dry ? { path: DRY_RUN_REPORT, cardinality: { accounts: dry.accounts, debits: dry.debits, credits: dry.credits } } : null,
      (l) => console.log(`  ${l}`)
    );

    let posted = 0;
    let already = 0;
    await client.query("BEGIN");
    try {
      // Evidencia compartida: el PDF del Balance Sheet, registrado una sola vez.
      const { rows: ev } = await client.query<{ id: string }>(
        `SELECT id FROM bank_opening_evidence WHERE sha256 = $1 AND deleted_at IS NULL LIMIT 1`,
        [evidenceSha]
      );
      const evidenceId =
        ev[0]?.id ??
        (await addOpeningBalanceEvidence(client, ACTOR, {
          name: basename(evidencePath), mime_type: "application/pdf", content_base64: evidenceBytes.toString("base64"),
        })).id;
      console.log(`  evidencia: ${basename(evidencePath)} sha256 ${evidenceSha.slice(0, 16)}… → ${evidenceId}${ev[0] ? " (ya registrada)" : ""}`);
      for (const p of nonZero) {
        const r = await postOpeningBalance(client, {
          account_list_id: p.list_id, day: DAY, balance_cents: p.balance_cents, evidence_ids: [evidenceId], items: [], actor_id: ACTOR,
        });
        if (r.status === "already_posted") already++;
        else posted++;
        console.log(`  ${r.status.padEnd(15)} ${p.full_name}`);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    const { rows: obe } = await client.query<{ cents: string }>(
      `SELECT COALESCE(SUM(l.credit_cents - l.debit_cents), 0)::text AS cents FROM bank_journal_line l
         JOIN bank_journal_entry e ON e.id = l.entry_id
        WHERE l.account_list_id = (SELECT qb_list_id FROM gl_account_map WHERE key = 'opening_balance_equity')
          AND e.source_kind = 'opening_balance' AND e.deleted_at IS NULL AND l.deleted_at IS NULL`
    );
    console.log(`\nAPLICADO · posteados ${posted} · ya estaban ${already} · OBE en el libro tras la carga: ${money(BigInt(obe[0]!.cents))} (QB: ${money(obeInReport)})`);
    if (BigInt(obe[0]!.cents) !== obeInReport) throw new Error(`[${TAG}] OBE post-carga no coincide con QB`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  const detail = (err as { details?: unknown }).details;
  console.error(err instanceof Error ? err.message : err, detail ? JSON.stringify(detail) : "");
  process.exit(1);
});
