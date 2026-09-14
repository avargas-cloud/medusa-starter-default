/**
 * rebuild-opening-from-feed — reconstruye el documento `opening_balance` de UNA
 * cuenta bancaria al corte (2025-12-31) con la información que QuickBooks nunca
 * tuvo: el saldo REAL del banco y las partidas en tránsito, derivadas del feed
 * de Plaid (Banking-on-GL §2: `balance_cents` = saldo del extracto al corte,
 * `items` = cheques pendientes / depósitos en tránsito).
 *
 *   DATABASE_URL=… ECOPOWERTECH_ENV=sandbox ./node_modules/.bin/tsx \
 *     src/scripts/ledger/rebuild-opening-from-feed.ts --mask 7223 [--apply] \
 *     [--cut 2025-12-31] [--horizon-days 60] [--tolerance-days 5] [--evidence chase.pdf]
 *
 * Derivación (Plaid: positivo = sale, negativo = entra):
 *   - saldo del banco al INICIO del día de corte: hoy − Σ movimientos posteados ≥ corte
 *     (el primer extracto arranca EN el día de corte, statement-read: from === cut_date).
 *   - partidas: cada movimiento del banco fechado ≥ corte (hasta corte+horizonte) SIN
 *     asiento del libro que lo explique (mismo monto, misma dirección, |Δdías| ≤ tolerancia)
 *     → el libro ya lo tenía ANTES del corte: sale = `outstanding_check`, entra =
 *     `deposit_in_transit`.
 *   - GUARD: saldo del banco + Σ partidas DEBE ser igual al saldo de libros de QB al
 *     corte (la línea `opening` actual) AL CENTAVO. Si no, no se toca nada y se reporta
 *     el residuo: es lo que el contador tiene que explicar.
 *
 * El neto contra Equity no cambia → Balance Sheet y trial balance idénticos.
 * `--apply` reversa el OBE vigente y postea el nuevo en UNA transacción.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { getDbPool } from "../../api/utils/db-pool";
import { postOpeningBalance } from "../../lib/ledger/documents/opening-balance";
import { reverseDocumentJournal } from "../../lib/ledger/post";
import type { OpeningBalanceItem } from "../../lib/ledger/lines/opening-balance";
import { addOpeningBalanceEvidence } from "../../lib/ledger/opening-evidence";

const ACTOR = "feed-opening-rebuild";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const cents = (v: string | number): bigint => BigInt(Math.round(Number(v) * 100));
const money = (c: bigint | number): string =>
  (Number(c) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const days = (a: string, b: string): number =>
  Math.abs((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
const plusDays = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type Line = { id: string; provider_transaction_id: string; day: string; amount: string; name: string };

async function main(): Promise<void> {
  const mask = arg("--mask");
  if (!mask) throw new Error("usage: --mask <4 dígitos> [--apply]");
  const apply = process.argv.includes("--apply");
  const cut = arg("--cut") ?? "2025-12-31";
  const horizon = Number(arg("--horizon-days") ?? "60");
  const tolerance = Number(arg("--tolerance-days") ?? "5");
  const evidencePath = arg("--evidence");
  const pool = getDbPool();

  const acct = (
    await pool.query<{ id: string; name: string; qb_list_id: string; current: string; type: string }>(
      `SELECT a.id,a.name,a.qb_list_id,a.balances->>'current' AS current,a.type FROM bank_account a
       WHERE a.mask=$1 AND a.type IN ('depository','credit') AND a.is_selected AND a.deleted_at IS NULL AND a.qb_list_id IS NOT NULL`,
      [mask]
    )
  ).rows;
  if (acct.length !== 1) throw new Error(`cuenta depository/credit *${mask} mapeada: ${acct.length} (esperaba 1)`);
  const a = acct[0]!;

  const obe = (
    await pool.query<{ entry_id: string; opening_cents: string; items: number }>(
      `SELECT e.id AS entry_id,(l.debit_cents-l.credit_cents)::text AS opening_cents,
              (SELECT count(*) FROM bank_journal_line x WHERE x.entry_id=e.id AND x.role LIKE 'uncleared_%')::int AS items
         FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id=e.id AND l.role='opening'
        WHERE e.source_kind='opening_balance' AND e.kind='document' AND e.source_id=$1 AND e.day=$2 AND e.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`,
      [a.qb_list_id, cut]
    )
  ).rows[0];
  if (!obe) throw new Error(`sin OBE vigente para ${a.qb_list_id} al ${cut}`);
  // Libro de QB al corte = opening + partidas ya declaradas (si este script ya corrió).
  const bookRow = await pool.query<{ book: string }>(
    `SELECT COALESCE(SUM(l.debit_cents-l.credit_cents),0)::text AS book FROM bank_journal_line l
      WHERE l.entry_id=$1 AND l.account_list_id=$2`,
    [obe.entry_id, a.qb_list_id]
  );
  const book = BigInt(bookRow.rows[0]!.book);

  const sums = await pool.query<{ since_cut: string }>(
    `SELECT COALESCE(SUM(amount::numeric) FILTER (WHERE transaction_date>=$2),0)::text AS since_cut
       FROM bank_transaction WHERE account_id=$1 AND status='posted' AND deleted_at IS NULL`,
    [a.id, cut]
  );
  // Tarjeta: `current` es deuda (positiva) y en el libro es pasivo → saldo libro = −deuda (ver reconcile-feed-statement).
  const bankAtCut = (a.type === "credit" ? -1n : 1n) * cents(a.current) + cents(sums.rows[0]!.since_cut); // saldo al inicio del día de corte

  const lines = (
    await pool.query<Line>(
      `SELECT id,provider_transaction_id,transaction_date::text AS day,amount::text,name FROM bank_transaction
        WHERE account_id=$1 AND status='posted' AND deleted_at IS NULL AND transaction_date BETWEEN $2 AND $3
        ORDER BY transaction_date,provider_transaction_id`,
      [a.id, cut, plusDays(cut, horizon)]
    )
  ).rows;
  // Asientos del libro sobre la cuenta desde el corte (excluye el propio OBE): son los que EXPLICAN un movimiento.
  const book_lines = (
    await pool.query<{ id: string; day: string; amount: string; reference: string }>(
      `SELECT l.id,e.day::text,(l.debit_cents-l.credit_cents)::text AS amount,e.reference
         FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id
        WHERE l.account_list_id=$1 AND e.kind='document' AND e.deleted_at IS NULL AND l.deleted_at IS NULL
          AND e.source_kind<>'opening_balance' AND e.day BETWEEN $2 AND $3
          AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`,
      [a.qb_list_id, plusDays(cut, -tolerance), plusDays(cut, horizon + tolerance)]
    )
  ).rows;
  const used = new Set<string>();
  const items: OpeningBalanceItem[] = [];
  const explained: Array<{ line: Line; by: string }> = [];
  // Dos líneas del banco del mismo día = UN asiento (wire + su fee: QB carga $7.906,69 + $25 como
  // un solo cheque de $7.931,69). Sin esto las dos salían como "partidas" y la apertura no cerraba.
  const pairExplained = new Set<string>();
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!, b = lines[j]!;
      if (a.day !== b.day || pairExplained.has(a.id) || pairExplained.has(b.id)) continue;
      const sum = -cents(a.amount) - cents(b.amount);
      const hit = book_lines.find((bl) => !used.has(bl.id) && BigInt(bl.amount) === sum && days(bl.day, a.day) <= tolerance);
      if (!hit) continue;
      used.add(hit.id);
      pairExplained.add(a.id).add(b.id);
      explained.push({ line: a, by: `${hit.day} ${hit.reference} (par)` }, { line: b, by: `${hit.day} ${hit.reference} (par)` });
    }
  for (const line of lines) {
    if (pairExplained.has(line.id)) continue;
    const amt = -cents(line.amount); // libro: + entra, − sale
    const candidates = book_lines
      .filter((b) => !used.has(b.id) && BigInt(b.amount) === amt && days(b.day, line.day) <= tolerance)
      .sort((x, y) => days(x.day, line.day) - days(y.day, line.day));
    if (candidates[0]) {
      used.add(candidates[0].id);
      explained.push({ line, by: `${candidates[0].day} ${candidates[0].reference}` });
      continue;
    }
    items.push({
      key: line.provider_transaction_id,
      kind: amt < 0n ? "outstanding_check" : "deposit_in_transit",
      original_day: line.day,
      amount_cents: amt < 0n ? -amt : amt,
      reference: line.name.slice(0, 160),
      description: `Banco ${line.day}: ${line.name.slice(0, 200)}`,
    });
  }
  // Partidas declaradas a mano (`--item kind:día:dólares:referencia`): lo que el feed no puede
  // derivar — un cheque que nunca va a pasar por el banco, una diferencia histórica que se
  // ajusta con un asiento del 01/01 porque el año anterior está cerrado (contador, 2026-09-14).
  // Van PRIMERO en el orden: son del corte por definición.
  const manual = process.argv.flatMap((a, i, all) => (a === "--item" && all[i + 1] ? [all[i + 1]!] : [])).map((raw, i) => {
    const [kind, day, dollars, ...ref] = raw.split(":");
    if ((kind !== "outstanding_check" && kind !== "deposit_in_transit") || !day || !dollars || !/^\d+(\.\d{1,2})?$/.test(dollars))
      throw new Error(`--item espera outstanding_check|deposit_in_transit:YYYY-MM-DD:dólares:referencia, recibió ${raw}`);
    const reference = ref.join(":") || `partida manual ${i + 1}`;
    return {
      key: `manual-${cut}-${i + 1}-${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`,
      kind,
      original_day: day,
      amount_cents: BigInt(Math.round(Number(dollars) * 100)),
      reference: reference.slice(0, 160),
      description: `Partida declarada ${day}: ${reference.slice(0, 200)}`,
    } satisfies OpeningBalanceItem;
  });
  // `--no-derive`: la apertura se explica SÓLO con las partidas declaradas (cuando el feed
  // posterior no permite derivarlas: procesadora que liquida varios lotes en una línea).
  if (process.argv.includes("--no-derive")) items.splice(0);
  items.unshift(...manual);
  // Regla del prefijo: las partidas de corte se amontonan justo después del corte. Se toman en
  // orden de fecha hasta que el residuo llega a cero; lo que sigue después ya es otro asunto
  // (splits, meses siguientes) y no es partida de apertura. Si nunca llega a cero, se listan todas.
  const net = (list: OpeningBalanceItem[]): bigint =>
    list.reduce((s, i) => s + (i.kind === "outstanding_check" ? -i.amount_cents : i.amount_cents), 0n);
  let prefix = items.length;
  for (let n = 0; n <= items.length; n++)
    if (book - (bankAtCut + net(items.slice(0, n))) === 0n) {
      prefix = n;
      break;
    }
  items.splice(prefix);
  const itemsNet = net(items);
  const residual = book - (bankAtCut + itemsNet);

  console.log(`${a.name} *${mask} (${a.qb_list_id}) · corte ${cut}`);
  console.log(`  libro QB al corte ${money(book)} · banco al inicio del ${cut} ${money(bankAtCut)} · partidas ${items.length} (neto ${money(itemsNet)}) · explicadas por el libro ${explained.length}/${lines.length}`);
  for (const i of items)
    console.log(`  ${i.kind === "outstanding_check" ? "CHEQUE PEND." : "DEP. TRÁNSITO"} ${i.original_day} ${money(i.amount_cents).padStart(12)} ${i.reference.slice(0, 70)}`);
  console.log(`  residuo (libro − banco − partidas) = ${money(residual)} ${residual === 0n ? "✓ CIERRA AL CENTAVO" : "✗ NO CIERRA → para el contador; no se postea"}`);
  if (obe.items > 0) console.log(`  (el OBE vigente ya tiene ${obe.items} partidas)`);
  if (!apply || residual !== 0n) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const snapshot = await client.query<{ evidence: Array<{ id: string }> }>(
      `SELECT source_snapshot->'evidence' AS evidence FROM bank_journal_entry WHERE id=$1`,
      [obe.entry_id]
    );
    const evidenceIds = (snapshot.rows[0]?.evidence ?? []).map((e) => e.id);
    if (evidencePath) {
      const bytes = readFileSync(evidencePath);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const ev = await client.query<{ id: string }>(`SELECT id FROM bank_opening_evidence WHERE sha256=$1 AND deleted_at IS NULL LIMIT 1`, [sha]);
      const id = ev.rows[0]?.id ?? (await addOpeningBalanceEvidence(client, ACTOR, {
        name: basename(evidencePath), mime_type: "application/pdf", content_base64: bytes.toString("base64"),
      })).id;
      evidenceIds.push(id);
    }
    // La reversa va fechada EN el corte, no hoy: una corrección de apertura no puede dejar la
    // apertura vieja viva en enero y cancelarla en septiembre (todo extracto intermedio la
    // contaría dos veces — pasó en el sandbox el 2026-09-14). `gl_document_source_unique`
    // admite reversa con el mismo día del original.
    const rev = await reverseDocumentJournal(client, {
      source_kind: "opening_balance", source_id: a.qb_list_id, day: cut,
      reason: `rebuild from bank feed: balance ${money(bankAtCut)} + ${items.length} items`, actor_id: ACTOR,
    });
    if (rev.status !== "reversed") throw new Error(`reversa: ${rev.status}`);
    // El builder del OBE espera el saldo en la dirección NATURAL de la cuenta: una tarjeta
    // (credit-normal) recibe lo adeudado en positivo; `bankAtCut` viene en signo GL (negativo).
    const post = await postOpeningBalance(client, {
      account_list_id: a.qb_list_id, day: cut, balance_cents: a.type === "credit" ? -bankAtCut : bankAtCut,
      evidence_ids: [...new Set(evidenceIds)], items, actor_id: ACTOR,
    });
    if (post.status !== "posted") throw new Error(`post: ${post.status}`);
    const check = await client.query<{ book: string }>(
      `SELECT COALESCE(SUM(l.debit_cents-l.credit_cents),0)::text AS book FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id
        WHERE e.source_kind='opening_balance' AND e.source_id=$1 AND l.account_list_id=$1 AND e.deleted_at IS NULL`,
      [a.qb_list_id]
    );
    if (BigInt(check.rows[0]!.book) !== book) throw new Error(`el libro cambió: ${check.rows[0]!.book} ≠ ${book}`);
    await client.query("COMMIT");
    console.log(`  APLICADO: OBE reversado y reposteado (${items.length} partidas); libro al corte sigue en ${money(book)}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    // Un LedgerError sin sus `details` es un código pelado (GL_SOURCE_INVALID tiene 3 motivos).
    const details = error instanceof Error && "details" in error ? (error as { details?: unknown }).details : undefined;
    console.error("rebuild-opening-from-feed:", error instanceof Error ? error.message : error, details ? JSON.stringify(details) : "");
    process.exit(1);
  });
