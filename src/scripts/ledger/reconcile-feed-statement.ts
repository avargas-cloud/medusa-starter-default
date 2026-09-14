/**
 * reconcile-feed-statement — concilia UN mes de UNA cuenta bancaria usando el feed
 * de Plaid como extracto (QuickBooks nunca concilió: no hay PDFs mensuales que
 * homologar, y el feed demostró ser completo — Chase 12/2025 cerró al centavo con
 * el saldo calculado, 2026-09-14).
 *
 *   ECOPOWERTECH_ENV=sandbox DATABASE_URL=… ./node_modules/.bin/tsx \
 *     src/scripts/ledger/reconcile-feed-statement.ts --mask 7223 --from 2026-01-01 --to 2026-01-31 \
 *     [--apply] [--tolerance-days 5] [--evidence path.pdf] [--actor a.vargas@ecopowertech.com] [--close]
 *
 * Qué hace (DRY-RUN por default: sólo calcula y lista; `--apply` escribe):
 *   1. Saldos del período CALCULADOS del feed: saldo de hoy − Σ movimientos posteados
 *      después de la fecha (Plaid: positivo = sale, negativo = entra).
 *   2. Setup de revisión de la cuenta (una vez): review_start = --from del primer mes,
 *      saldo de apertura = saldo calculado al día anterior.
 *   3. Evidencia: el PDF dado, o un PDF generado con las líneas del feed del período.
 *   4. Extracto (`bank_statement`) con las líneas del feed del período.
 *   5. Casamiento automático línea ↔ asiento del libro: mismo monto, misma dirección,
 *      |Δdías| ≤ tolerancia, candidato ÚNICO (empate = no se casa, va al reporte).
 *   6. Preview: diferencia, casados, y las dos listas que quedan (líneas del banco sin
 *      asiento · asientos del libro sin línea) → `.bank-recon/<mask>_<from>_<to>.md`.
 *   `--close` cierra el extracto sólo si la diferencia es 0.
 *
 * Todo pasa por las mismas funciones de lib/banking que usa la UI (guards, hashes,
 * idempotencia, eventos). Nada de SQL directo sobre tablas de Banking.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { getDbPool } from "../../api/utils/db-pool";
import { addCompletionEvidence } from "../../lib/banking/completion-evidence";
import {
  receiptSetup,
  saveReceiptSetup,
} from "../../lib/banking/receipts-setup";
import { withReviewLock } from "../../lib/banking/review-common";
import { saveAccountSetup } from "../../lib/banking/review-setup";
import {
  previewStatement,
  saveStatement,
  closeStatement,
} from "../../lib/banking/statement-core";
import { matchStatement, unmatchStatement } from "../../lib/banking/statement-matching";
import { statementContext } from "../../lib/banking/statement-read";
import type {
  StatementBookItem,
  StatementContext,
  StatementLine,
} from "../../lib/banking/statement-types";
import { transaction } from "../../lib/banking/store";

type Args = {
  mask: string;
  from: string;
  to: string;
  apply: boolean;
  close: boolean;
  reset: boolean;
  toleranceDays: number;
  evidence: string | null;
  actor: string;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const mask = get("--mask"),
    from = get("--from"),
    to = get("--to");
  if (!mask || !from || !to)
    throw new Error("usage: --mask <4 dígitos> --from YYYY-MM-DD --to YYYY-MM-DD");
  return {
    mask,
    from,
    to,
    apply: argv.includes("--apply"),
    close: argv.includes("--close"),
    reset: argv.includes("--reset"),
    toleranceDays: Number(get("--tolerance-days") ?? "5"),
    evidence: get("--evidence"),
    actor: get("--actor") ?? "a.vargas@ecopowertech.com",
  };
}

const cents = (value: string | number): number =>
  Math.round(Number(value) * 100);
const money = (c: number): string =>
  (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const dayBefore = (day: string): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const daysAgo = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string): number =>
  Math.abs(
    (Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000
  );
const key = (parts: string[]): string =>
  createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40);

type FeedRow = {
  id: string;
  provider_transaction_id: string;
  transaction_date: string;
  amount: string;
  name: string;
};

/** PDF mínimo de texto (Courier 9pt, varias páginas) — evidencia generada del feed. */
function feedPdf(title: string, lines: string[]): Buffer {
  const esc = (s: string): string =>
    s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, (m) => `\\${m}`);
  const perPage = 60,
    pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage)
    pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([]);
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const pageIds: number[] = [];
  const pagesId = objects.length + pages.length * 2 + 1;
  for (const page of pages) {
    const text = [
      "BT /F1 9 Tf 36 770 Td 11 TL",
      `(${esc(title)}) Tj T*`,
      ...page.map((l) => `(${esc(l)}) Tj T*`),
      "ET",
    ].join("\n");
    const stream = add(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`
      )
    );
  }
  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");
  const pagesObj = add(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`);
  if (pagesObj !== pagesId) throw new Error("pdf object numbering");
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = getDbPool();
  const actor = (
    await pool.query<{ id: string }>(
      `SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`,
      [args.actor]
    )
  ).rows[0];
  if (!actor) throw new Error(`actor no encontrado: ${args.actor}`);
  const account = (
    await pool.query<{
      id: string;
      name: string;
      qb_list_id: string | null;
      review_start_date: string | null;
      setup_revision: number;
      current: string | null;
      type: string;
    }>(
      `SELECT a.id,a.name,a.qb_list_id,a.review_start_date,a.setup_revision,a.balances->>'current' AS current,a.type
       FROM bank_account a WHERE a.mask=$1 AND a.type IN ('depository','credit') AND a.is_selected AND a.deleted_at IS NULL`,
      [args.mask]
    )
  ).rows;
  if (account.length !== 1)
    throw new Error(`cuenta depository/credit *${args.mask}: ${account.length} filas (esperaba 1)`);
  const acct = account[0]!;
  if (!acct.qb_list_id) throw new Error(`*${args.mask} no está mapeada a una cuenta QB`);

  // 0. Sin extracto previo, el primero arranca EN el día de corte del OBE (statement-read exige
  //    from === cut_date y apertura === saldo del banco al inicio de ese día).
  const prior = await pool.query<{ to_day: string }>(
    `SELECT to_day::text FROM bank_statement WHERE bank_account_id=$1 AND deleted_at IS NULL ORDER BY to_day DESC LIMIT 1`,
    [acct.id]
  );
  if (!prior.rows[0]) {
    const cut = await pool.query<{ day: string }>(
      `SELECT e.day::text FROM bank_journal_entry e WHERE e.source_kind='opening_balance' AND e.kind='document' AND e.source_id=$1
        AND e.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id)`,
      [acct.qb_list_id]
    );
    const cutDay = cut.rows[0]?.day;
    if (!cutDay) throw new Error(`*${args.mask}: la cuenta QB no tiene apertura (OBE) vigente`);
    if (args.from !== cutDay) {
      console.log(`primer extracto de la cuenta: arranca en el corte ${cutDay} (pedido ${args.from})`);
      args.from = cutDay;
    }
  }

  // 1. Saldos calculados del feed (posted, no removed).
  const sums = await pool.query<{ after_from: string; after_to: string }>(
    `SELECT COALESCE(SUM(amount::numeric) FILTER (WHERE transaction_date>=$2),0)::text AS after_from,
            COALESCE(SUM(amount::numeric) FILTER (WHERE transaction_date>$3),0)::text AS after_to
       FROM bank_transaction WHERE account_id=$1 AND status='posted' AND deleted_at IS NULL`,
    [acct.id, args.from, args.to]
  );
  // Depository: `current` = saldo a favor; Plaid + sale, − entra → saldo antes = hoy + Σ posteriores.
  // Tarjeta (credit): `current` = lo que se DEBE (positivo); un cargo (Plaid +) lo sube → deuda antes =
  // hoy − Σ posteriores, y en el libro la tarjeta es pasivo (signo negativo): saldo libro = −deuda.
  const current = cents(acct.current ?? "0");
  const sign = acct.type === "credit" ? -1 : 1;
  const opening = sign * current + cents(sums.rows[0]!.after_from);
  const closing = sign * current + cents(sums.rows[0]!.after_to);
  const feed = (
    await pool.query<FeedRow>(
      `SELECT id,provider_transaction_id,transaction_date::text,amount::text,name FROM bank_transaction
       WHERE account_id=$1 AND status='posted' AND deleted_at IS NULL AND transaction_date BETWEEN $2 AND $3
       ORDER BY transaction_date,provider_transaction_id`,
      [acct.id, args.from, args.to]
    )
  ).rows;
  const lines = feed.map((row) => ({
    // NO el id de Plaid: el extracto compara claves en minúscula y Plaid emitió dos ids que sólo
    // difieren en mayúsculas (Chase 2026-04, …KqR / …Kqr) → falso BANKING_STATEMENT_DUPLICATE_LINE.
    external_key: row.id,
    day: row.transaction_date,
    amount_cents: -cents(row.amount),
    description: row.name.slice(0, 500),
    transaction_id: row.id,
  }));
  const credits = lines.reduce((s, l) => s + Math.max(l.amount_cents, 0), 0);
  const debits = lines.reduce((s, l) => s + Math.max(-l.amount_cents, 0), 0);
  console.log(
    `${acct.name} *${args.mask} · ${args.from}..${args.to} · apertura ${money(opening)} · entradas ${money(credits)} · salidas ${money(debits)} · cierre ${money(closing)} · ${lines.length} líneas`
  );
  if (opening + credits - debits !== closing)
    throw new Error("los saldos calculados no cierran con las líneas (¿pendientes/removed?)");
  if (!args.apply) {
    console.log("DRY-RUN: no se escribe nada. Usá --apply para crear el extracto y casar.");
    return;
  }

  // 2. Setup contable (una vez) + setup de revisión de la cuenta (una vez).
  const client = await pool.connect();
  try {
    const setup = await transaction(client, async () => {
      await withReviewLock(client);
      return receiptSetup(client);
    });
    if (!setup) {
      const map = await pool.query<{ key: string; qb_list_id: string }>(
        `SELECT key,qb_list_id FROM gl_account_map WHERE key IN ('accounts_receivable','undeposited_funds')`
      );
      const ar = map.rows.find((r) => r.key === "accounts_receivable")?.qb_list_id;
      const uf = map.rows.find((r) => r.key === "undeposited_funds")?.qb_list_id;
      if (!ar || !uf) throw new Error("gl_account_map sin accounts_receivable/undeposited_funds");
      await saveReceiptSetup(actor.id, key(["setup", "2025-12-31"]), {
        expected_revision: 0,
        cut_date: "2025-12-31",
        ar_account_list_id: ar,
        clearing_account_list_id: uf,
        local_usd_attested: true,
      });
      console.log("setup contable creado (corte 2025-12-31, AR + Undeposited Funds, USD atestado)");
    }
  } finally {
    client.release();
  }
  if (!acct.review_start_date) {
    await saveAccountSetup(actor.id, acct.id, key(["review-setup", acct.id, args.from]), {
      expected_revision: acct.setup_revision,
      review_start_date: args.from,
      opening_bank_balance: (opening / 100).toFixed(2),
      opening_reference: `Feed Plaid — saldo calculado al ${dayBefore(args.from)}`,
      opening_book_balance: null,
    });
    console.log(`review setup: empieza ${args.from}, apertura ${money(opening)}`);
  }

  // 3. Evidencia.
  const evidenceName = args.evidence
    ? path.basename(args.evidence)
    : `feed_${args.mask}_${args.from}_${args.to}.pdf`;
  const evidenceBytes = args.evidence
    ? fs.readFileSync(args.evidence)
    : feedPdf(
        `${acct.name} *${args.mask}  ${args.from}..${args.to}  opening ${money(opening)}  closing ${money(closing)}  (Plaid feed)`,
        lines.map(
          (l) =>
            `${l.day}  ${money(l.amount_cents).padStart(14)}  ${l.description.slice(0, 70)}`
        )
      );
  const evidence = await addCompletionEvidence(actor.id, key(["evidence", acct.id, args.from, args.to]), {
    name: evidenceName,
    mime_type: "application/pdf",
    content_base64: evidenceBytes.toString("base64"),
  });

  // 4. Extracto (idempotente por key: re-correr devuelve el mismo).
  const existing = await pool.query<{ id: string; revision: number; status: string }>(
    `SELECT id,revision,status FROM bank_statement WHERE bank_account_id=$1 AND from_day=$2 AND to_day=$3 AND deleted_at IS NULL`,
    [acct.id, args.from, args.to]
  );
  let context: StatementContext;
  if (existing.rows[0] && args.reset) {
    // Rehacer un mes: se descasan las líneas (auditado) y el borrador se retira. Nunca un extracto cerrado.
    if (existing.rows[0].status !== "draft") throw new Error(`--reset: el extracto ${existing.rows[0].id} está ${existing.rows[0].status}`);
    const ids = (await pool.query<{ id: string }>(`SELECT id FROM bank_statement_match WHERE statement_id=$1 AND deleted_at IS NULL`, [existing.rows[0].id])).rows.map((r) => r.id);
    let rev = existing.rows[0].revision;
    for (let i = 0; i < ids.length; i += 100) {
      const ctx = await unmatchStatement(existing.rows[0].id, actor.id, key(["unmatch", existing.rows[0].id, String(rev), String(i)]), {
        expected_revision: rev, match_ids: ids.slice(i, i + 100), reason: "reconcile-feed-statement --reset: se rehace el mes",
      });
      rev = ctx.statement.revision;
    }
    // El borrador se REESCRIBE en el lugar (la unique (cuenta, from, to) no admite retirarlo):
    // mismo id, revisión actual, líneas y saldos recalculados del feed.
    existing.rows[0].revision = rev;
    console.log(`reset: ${ids.length} casamientos deshechos; borrador ${existing.rows[0].id} se reescribe (rev ${rev})`);
  }
  if (existing.rows[0] && args.reset) {
    context = await saveStatement(actor.id, key(["statement-rewrite", existing.rows[0].id, String(existing.rows[0].revision)]), {
      id: existing.rows[0].id,
      expected_revision: existing.rows[0].revision,
      bank_account_id: acct.id,
      from: args.from,
      to: args.to,
      reference: `Plaid feed ${args.mask} ${args.from}..${args.to}`,
      evidence_id: evidence.evidence.id,
      opening_balance_cents: opening,
      closing_balance_cents: closing,
      declared_line_count: lines.length,
      declared_credits_cents: credits,
      declared_debits_cents: debits,
      completeness_attested: true,
      lines,
    });
    console.log(`extracto reescrito: ${context.statement.id} (rev ${context.statement.revision})`);
  } else if (existing.rows[0]) {
    console.log(`extracto ya existe: ${existing.rows[0].id} (${existing.rows[0].status}, rev ${existing.rows[0].revision})`);
    const c = await pool.connect();
    try {
      context = await transaction(c, async () => {
        await withReviewLock(c);
        return statementContext(c, existing.rows[0]!.id);
      });
    } finally {
      c.release();
    }
  } else {
    const retired = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bank_statement WHERE bank_account_id=$1 AND from_day=$2 AND to_day=$3 AND deleted_at IS NOT NULL`,
      [acct.id, args.from, args.to]
    );
    context = await saveStatement(actor.id, key(["statement", acct.id, args.from, args.to, retired.rows[0]!.n]), {
      expected_revision: 0,
      bank_account_id: acct.id,
      from: args.from,
      to: args.to,
      reference: `Plaid feed ${args.mask} ${args.from}..${args.to}`,
      evidence_id: evidence.evidence.id,
      opening_balance_cents: opening,
      closing_balance_cents: closing,
      declared_line_count: lines.length,
      declared_credits_cents: credits,
      declared_debits_cents: debits,
      completeness_attested: true,
      lines,
    });
    console.log(`extracto creado: ${context.statement.id}`);
  }

  // 5. Casamiento automático.
  const matchedLines = new Set(context.matches.map((m) => m.statement_line_id));
  // Restante CON SIGNO (el motor lo entrega en valor absoluto): un reembolso es −72,64 y un
  // depósito +3.704,00, así una línea del banco puede ser la suma neta de ambos.
  const remaining = new Map<string, number>(
    context.book_items.map((b) => [b.id, Math.sign(b.amount_cents) * b.remaining_cents])
  );
  const rem = (b: StatementBookItem): number => Math.abs(remaining.get(b.id) ?? 0);
  const allocations: Array<{
    statement_line_id: string;
    book_kind: "journal_line";
    book_id: string;
    amount_cents: number;
    expected_book_hash: string;
  }> = [];
  const ambiguous: Array<{ line: StatementLine; candidates: StatementBookItem[] }> = [];
  const checkNo = (text: string): string | null =>
    /\bCHECK\s*#?\s*(\d{2,7})\b/i.exec(text)?.[1] ?? null;
  const sameSide = (b: StatementBookItem, l: StatementLine): boolean =>
    Math.sign(b.amount_cents) === Math.sign(l.amount_cents);
  // Las partidas en tránsito de la apertura están fechadas al corte pero el banco las
  // muestra semanas después: tolerancia amplia sólo para ellas.
  const isOpening = (b: StatementBookItem): boolean => /^Opening balance /.test(b.reference);
  // Un pago de bill por cheque del POS (BP-####) no lleva el número de cheque (vive en QB) y el
  // banco lo cobra hasta 2-3 semanas después (BP-1066 15/07 → CHECK #630 30/07): tolerancia de
  // cheque en tránsito, siempre con candidato ÚNICO.
  const isPosCheck = (b: StatementBookItem): boolean => /^BP-\d+/.test(b.reference) && b.amount_cents < 0;
  const within = (b: StatementBookItem, l: StatementLine): boolean =>
    daysBetween(b.day, l.day) <= (isOpening(b) ? 60 : isPosCheck(b) ? 30 : args.toleranceDays);
  const allocate = (line: StatementLine, book: StatementBookItem, amount: number): void => {
    remaining.set(book.id, (remaining.get(book.id) ?? 0) - Math.sign(book.amount_cents) * amount);
    matchedLines.add(line.id);
    allocations.push({
      statement_line_id: line.id,
      book_kind: "journal_line",
      book_id: book.id,
      amount_cents: amount,
      expected_book_hash: book.source_hash,
    });
  };
  const open = (): StatementLine[] => context.lines.filter((l) => !matchedLines.has(l.id) && !l.blockers.length);
  // Un asiento ANULADO al cierre (reversa, o documento con reversa fechada ≤ to) no se casa: su par
  // suma cero y contamina al solver de neteos — cualquier solución + el par es otra solución, y
  // "más de una solución" es "no se casa" (medido 2026-09-14: MER BNKCD $3.183,56 dejó de casar
  // apenas apareció un par reversa/repost el 07-01). Y el banco pagó el documento VIVO (el bill
  // payment del POS), no la copia importada de QB que se reversó.
  const canceled = new Set(
    (
      await pool.query<{ id: string }>(
        `SELECT l.id FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id
          WHERE l.id = ANY($1::text[])
            AND (e.kind='reversal' OR EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id AND r.day<=$2))`,
        [context.book_items.map((b) => b.id), args.to]
      )
    ).rows.map((r) => r.id)
  );
  const books = (): StatementBookItem[] =>
    context.book_items.filter((b) => !b.blockers.length && rem(b) !== 0 && !canceled.has(b.id));

  // 5a. Número de cheque: el banco dice "CHECK # 796" y el libro "QB Check 796" → se casan aunque
  //     haya otros cheques del mismo monto; la fecha puede diferir semanas.
  for (const line of open()) {
    const no = checkNo(line.description);
    if (!no) continue;
    const hit = books().filter(
      (b) => sameSide(b, line) && rem(b) === Math.abs(line.amount_cents) && (checkNo(b.reference) === no || checkNo(b.description) === no)
    );
    if (hit.length === 1) allocate(line, hit[0]!, Math.abs(line.amount_cents));
  }
  // 5b. Monto exacto + fecha cercana, candidato único.
  for (const line of open()) {
    const candidates = books()
      .filter(
        (b) =>
          sameSide(b, line) &&
          rem(b) === Math.abs(line.amount_cents) &&
          within(b, line)
      )
      .sort((a, b) => daysBetween(a.day, line.day) - daysBetween(b.day, line.day));
    if (!candidates.length) continue;
    const best = candidates[0]!;
    const tie = candidates.filter((c) => daysBetween(c.day, line.day) === daysBetween(best.day, line.day));
    if (tie.length > 1) {
      // k líneas iguales (mismo monto y día) contra k asientos iguales: cualquier emparejamiento es
      // el mismo; se emparejan en orden. Si los conteos difieren, sí es ambiguo.
      const twins = open().filter((l) => l.day === line.day && l.amount_cents === line.amount_cents);
      if (twins.length === tie.length) {
        twins.forEach((l, i) => allocate(l, tie[i]!, Math.abs(l.amount_cents)));
        continue;
      }
      ambiguous.push({ line, candidates: tie });
      continue;
    }
    allocate(line, best, Math.abs(line.amount_cents));
  }
  // 5c. Sumas: varias líneas del banco del MISMO día = un asiento (ATM $20 + $320 = depósito $340;
  //     $9.320 + $440 + $20 + $20 = cheque Cash $9.800). Combinaciones de 2 a 4.
  const combos = <T,>(list: T[], size: number): T[][] => {
    const out: T[][] = [];
    const walk = (start: number, acc: T[]): void => {
      if (acc.length === size) {
        out.push(acc);
        return;
      }
      for (let i = start; i < list.length; i++) walk(i + 1, [...acc, list[i]!]);
    };
    walk(0, []);
    return out;
  };
  //     Primero las líneas del MISMO día del asiento, después la tolerancia: tres wires a VEETECH
  //     con su fee de $25 cada uno daban dos combinaciones válidas (los $25 son intercambiables)
  //     y "ambiguo" dejaba junio de Wells sin cerrar (2026-09-14).
  for (const book of books()) {
    const target = remaining.get(book.id) ?? 0; // con signo, igual que line.amount_cents
    let done = false;
    for (const window of [0, args.toleranceDays]) {
      const pool_ = open().filter((l) => sameSide(book, l) && daysBetween(l.day, book.day) <= window);
      for (const size of [2, 3, 4]) {
        const hit = combos(pool_, size).filter((set) => set.reduce((s, l) => s + l.amount_cents, 0) === target);
        if (hit.length === 1) {
          for (const l of hit[0]!) allocate(l, book, Math.abs(l.amount_cents));
          done = true;
          break;
        }
      }
      if (done) break;
    }
  }
  // Una línea del banco = suma NETA de varios asientos cercanos: la procesadora de tarjetas
  // deposita ventas menos reembolsos del día ($3.704 + $22,42 − $72,64 − $97,93 − $111,01 = $3.444,84).
  // Subconjuntos de hasta 5 asientos (cualquier signo) fechados a ±tolerancia; sólo si hay UNA solución.
  // Neteo por DÍA de libro: la procesadora liquida las ventas y reembolsos de UN día y el banco lo
  // muestra 1-3 días después. Para cada línea se prueban los asientos de un mismo día (el más
  // cercano hacia atrás primero), subconjuntos de 2 a 6, solución única.
  for (const line of open()) {
    let done = false;
    for (let back = 0; back <= args.toleranceDays && !done; back++) {
      // Cluster de 3 días terminando en d (la liquidación puede juntar el fin de semana).
      const d = daysAgo(line.day, back);
      const d2 = daysAgo(d, 2);
      const pool_ = books().filter((b) => b.day <= d && b.day >= d2);
      if (pool_.length < 2 || pool_.length > 20) continue;
      const solutions: StatementBookItem[][] = [];
      const walk = (start: number, acc: StatementBookItem[], sum: number): void => {
        if (solutions.length > 1) return;
        if (acc.length >= 2 && sum === line.amount_cents) {
          solutions.push(acc);
          return;
        }
        if (acc.length === 8) return;
        for (let i = start; i < pool_.length; i++) walk(i + 1, [...acc, pool_[i]!], sum + (remaining.get(pool_[i]!.id) ?? 0));
      };
      walk(0, [], 0);
      if (solutions.length === 1) {
        for (const b of solutions[0]!) allocate(line, b, rem(b));
        done = true;
      }
    }
  }
  // Ventanas crecientes (±1, ±2, ±tolerancia): la solución más cercana en fecha gana; en cada
  // ventana se exige solución ÚNICA. Pool acotado a 40 asientos (C(40,5) ≈ 660k por línea).
  for (const line of open()) {
    for (const window of [1, 2, args.toleranceDays]) {
      const pool_ = books()
        .filter((b) => daysBetween(b.day, line.day) <= window)
        .sort((a, b) => a.day.localeCompare(b.day));
      if (pool_.length > 40) break;
      const solutions: StatementBookItem[][] = [];
      const walk = (start: number, acc: StatementBookItem[], sum: number): void => {
        if (solutions.length > 1) return;
        if (acc.length >= 2 && sum === line.amount_cents) {
          solutions.push(acc);
          return;
        }
        if (acc.length === 5) return;
        for (let i = start; i < pool_.length; i++) walk(i + 1, [...acc, pool_[i]!], sum + (remaining.get(pool_[i]!.id) ?? 0));
      };
      walk(0, [], 0);
      if (solutions.length === 1) {
        // Cada asiento entra completo; la línea recibe |monto| de cada uno (el signo lo lleva el asiento).
        for (const b of solutions[0]!) allocate(line, b, rem(b));
        break;
      }
      if (solutions.length > 1) break; // ambiguo ya en la ventana chica: no ampliar
    }
  }
  // Los asientos de signo opuesto a su línea van primero: el trigger de capacidad suma con signo
  // y una suma parcial que arranque por el depósito excedería la línea neteada.
  const lineSign = new Map(context.lines.map((l) => [l.id, Math.sign(l.amount_cents)]));
  const bookSign = new Map(context.book_items.map((b) => [b.id, Math.sign(b.amount_cents)]));
  allocations.sort((x, y) => {
    const ox = bookSign.get(x.book_id) === lineSign.get(x.statement_line_id) ? 1 : 0;
    const oy = bookSign.get(y.book_id) === lineSign.get(y.statement_line_id) ? 1 : 0;
    return ox - oy;
  });
  let revision = context.statement.revision;
  for (let i = 0; i < allocations.length; i += 100) {
    const batch = allocations.slice(i, i + 100);
    context = await matchStatement(context.statement.id, actor.id, key(["match", context.statement.id, String(revision), String(i)]), {
      expected_revision: revision,
      allocations: batch,
    });
    revision = context.statement.revision;
  }

  // 6. Preview + reporte.
  const preview = await previewStatement(context.statement.id, actor.id, key(["preview", context.statement.id, String(revision)]), {
    expected_revision: revision,
  });
  const matchedNow = new Set(context.matches.map((m) => m.statement_line_id));
  const bankOnly = context.lines.filter((l) => !matchedNow.has(l.id));
  const bookOnly = context.book_items.filter((b) => b.remaining_cents !== 0 && b.day <= args.to && !canceled.has(b.id));
  // Pares anulados: se listan aparte, con su neto — ruido conocido (bill payments del POS con la copia
  // de QB reversada, re-fechados), no partidas pendientes.
  const noise = context.book_items.filter((b) => b.remaining_cents !== 0 && b.day <= args.to && canceled.has(b.id));
  const signedRem = (b: StatementBookItem): number => Math.sign(b.amount_cents) * b.remaining_cents;
  const report = [
    `# ${acct.name} *${args.mask} — ${args.from}..${args.to}`,
    ``,
    `- Apertura (feed) ${money(opening)} · Cierre (feed) ${money(closing)} · líneas ${context.lines.length}`,
    `- Casadas automáticamente: ${context.matches.length} (${allocations.length} en esta corrida) · ambiguas ${ambiguous.length}`,
    `- Saldo del libro al ${args.to}: ${money(context.book_balance_cents)} · diferencia: **${money(context.difference_cents)}**`,
    `- Depósitos en tránsito ${money(context.deposits_in_transit_cents)} · cheques pendientes ${money(context.outstanding_disbursements_cents)}`,
    `- Bloqueos: ${context.blockers.length ? context.blockers.join(", ") : "ninguno"}`,
    ``,
    `## El banco lo tiene y el libro no (${bankOnly.length})`,
    `| Fecha | Monto | Descripción |`,
    `|---|---|---|`,
    ...bankOnly.map((l) => `| ${l.day} | ${money(l.amount_cents)} | ${l.description.replace(/\|/g, "/").slice(0, 90)} |`),
    ``,
    `## El libro lo tiene y el banco no (${bookOnly.length}) — hasta ${args.to}`,
    `| Fecha | Monto | Referencia | Descripción |`,
    `|---|---|---|---|`,
    ...bookOnly.map((b) => `| ${b.day} | ${money(signedRem(b))} | ${b.reference.replace(/\|/g, "/")} | ${b.description.replace(/\|/g, "/").slice(0, 70)} |`),
    ``,
    `## Asientos anulados con su reversa (ruido, neto ${money(noise.reduce((s, b) => s + signedRem(b), 0))}) (${noise.length})`,
    `| Fecha | Monto | Referencia |`,
    `|---|---|---|`,
    ...noise.map((b) => `| ${b.day} | ${money(signedRem(b))} | ${b.reference.replace(/\|/g, "/").slice(0, 70)} |`),
    ``,
    `## Ambiguas (más de un asiento posible, no se casaron) (${ambiguous.length})`,
    ...ambiguous.map(
      (a) => `- ${a.line.day} ${money(a.line.amount_cents)} ${a.line.description.slice(0, 60)} → ${a.candidates.map((c) => `${c.day} ${c.reference}`).join(" | ")}`
    ),
    ``,
  ].join("\n");
  fs.mkdirSync(".bank-recon", { recursive: true });
  const reportPath = path.join(".bank-recon", `${args.mask}_${args.from}_${args.to}.md`);
  fs.writeFileSync(reportPath, report);
  console.log(
    `casadas ${context.matches.length}/${context.lines.length} · banco-sin-libro ${bankOnly.length} · libro-sin-banco ${bookOnly.length} · ambiguas ${ambiguous.length} · diferencia ${money(context.difference_cents)} · reporte ${reportPath}`
  );
  if (args.close) {
    if (context.difference_cents !== 0) {
      console.log("NO se cierra: la diferencia no es 0");
      return;
    }
    await closeStatement(context.statement.id, actor.id, key(["close", context.statement.id, String(revision)]), {
      expected_revision: revision,
      preview_hash: (preview as { preview_hash: string }).preview_hash,
    });
    console.log("extracto CERRADO");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("reconcile-feed-statement:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
