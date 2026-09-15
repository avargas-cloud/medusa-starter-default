/**
 * reconcile-feed-statement — concilia UN mes de UNA cuenta bancaria usando el feed
 * de Plaid como extracto (QuickBooks nunca concilió: no hay PDFs mensuales que
 * homologar, y el feed demostró ser completo — Chase 12/2025 cerró al centavo con
 * el saldo calculado, 2026-09-14).
 *
 *   ECOPOWERTECH_ENV=sandbox DATABASE_URL=… ./node_modules/.bin/tsx \
 *     src/scripts/ledger/reconcile-feed-statement.ts --mask 7223 --from 2026-01-01 --to 2026-01-31 \
 *     [--apply] [--tolerance-days 5] [--evidence path.pdf] [--actor a.vargas@ecopowertech.com] [--close]
 *     [--td <extracto.txt> ...]   # sin feed: las líneas salen del PDF de TD (pdftotext -layout), ver td-statement-text
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
import { feedPdf } from "../../lib/banking/feed-evidence-pdf";
import { statementContext } from "../../lib/banking/statement-read";
import { loadSuggestParams, suggestStatement } from "../../lib/banking/statement-suggest";
import type {
  StatementBookItem,
  StatementContext,
} from "../../lib/banking/statement-types";
import { transaction } from "../../lib/banking/store";
import { readTdStatement, tdWindow } from "./td-statement-text";

type Args = {
  mask: string;
  from: string;
  to: string;
  apply: boolean;
  close: boolean;
  reset: boolean;
  toleranceDays: number;
  /** Tolerancia para un BP-#### del POS (cheque en tránsito, sin número): default 30 d. BP-1069 del
   *  07/26 cobrado el 09/04 (40 d) quedaba fuera y a mano (2026-09-15). */
  bpToleranceDays: number;
  evidence: string | null;
  actor: string;
  /** Extractos de TD en texto (uno o varios, consecutivos): reemplazan al feed como fuente de líneas. */
  td: string[];
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
    bpToleranceDays: Number(get("--bp-tolerance-days") ?? "30"),
    evidence: get("--evidence"),
    actor: get("--actor") ?? "a.vargas@ecopowertech.com",
    td: argv.flatMap((a, i, all) => (a === "--td" && all[i + 1] ? [all[i + 1]!] : [])),
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
const key = (parts: string[]): string =>
  createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40);

type FeedRow = {
  id: string;
  provider_transaction_id: string;
  transaction_date: string;
  amount: string;
  name: string;
};

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
    // Sin OBE: apertura de CERO (la cuenta no existía al corte — Visa 7914). `statementBank`
    // verifica que el libro tampoco tenga asientos hasta el corte; acá sólo se toma la fecha.
    const cutDay =
      cut.rows[0]?.day ??
      (await pool.query<{ cut_date: string }>(`SELECT cut_date::text FROM bank_accounting_setup WHERE id='local-usd' AND deleted_at IS NULL`)).rows[0]?.cut_date;
    if (!cutDay) throw new Error(`*${args.mask}: la cuenta QB no tiene apertura (OBE) vigente ni hay setup contable`);
    if (args.from !== cutDay) {
      console.log(`primer extracto de la cuenta: arranca en el corte ${cutDay} (pedido ${args.from})`);
      args.from = cutDay;
    }
  }

  // 1. Saldos y líneas del período: del feed de Plaid, o de los PDF del banco (`--td`) cuando el
  //    feed no llega tan atrás (TD ·9209 empieza el 2026-07-01; dic→jun salen de los extractos).
  type Line = { external_key: string; day: string; amount_cents: number; description: string; transaction_id: string | null };
  let opening: number, closing: number, lines: Line[];
  if (args.td.length) {
    if (!args.evidence) throw new Error("--td exige --evidence <pdf del banco>: el extracto es la evidencia, no se genera");
    const w = tdWindow(args.td.map(readTdStatement), args.from, args.to);
    opening = w.opening_cents;
    closing = w.closing_cents;
    lines = w.lines.map((l) => ({ ...l, description: l.description.slice(0, 500), transaction_id: null }));
  } else {
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
    opening = sign * current + cents(sums.rows[0]!.after_from);
    closing = sign * current + cents(sums.rows[0]!.after_to);
    const feed = (
      await pool.query<FeedRow>(
        `SELECT id,provider_transaction_id,transaction_date::text,amount::text,name FROM bank_transaction
         WHERE account_id=$1 AND status='posted' AND deleted_at IS NULL AND transaction_date BETWEEN $2 AND $3
         ORDER BY transaction_date,provider_transaction_id`,
        [acct.id, args.from, args.to]
      )
    ).rows;
    lines = feed.map((row) => ({
      // NO el id de Plaid: el extracto compara claves en minúscula y Plaid emitió dos ids que sólo
      // difieren en mayúsculas (Chase 2026-04, …KqR / …Kqr) → falso BANKING_STATEMENT_DUPLICATE_LINE.
      external_key: row.id,
      day: row.transaction_date,
      amount_cents: -cents(row.amount),
      description: row.name.slice(0, 500),
      transaction_id: row.id,
    }));
  }
  const source = args.td.length ? "TD statement" : "Plaid feed";
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
      opening_reference: `${source} — saldo al inicio del ${args.from} (fin del ${dayBefore(args.from)})`,
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
  // Un borrador se identifica por su `from`: el motor rechaza `to` > hoy, así que un mes en curso se
  // abre 09/01→hoy y se REESCRIBE con `--reset` a 09/01→09/30 cuando el feed cubre el mes (2026-09-15).
  // Sin --reset, un borrador del mismo `from` con otro `to` aborta: dos borradores solapados se roban
  // los casamientos entre sí.
  const existing = await pool.query<{ id: string; revision: number; status: string; to_day: string }>(
    `SELECT id,revision,status,to_day::text FROM bank_statement WHERE bank_account_id=$1 AND from_day=$2 AND deleted_at IS NULL
      AND (to_day=$3 OR status='draft') ORDER BY (to_day=$3) DESC LIMIT 1`,
    [acct.id, args.from, args.to]
  );
  if (existing.rows[0] && existing.rows[0].to_day !== args.to) {
    if (!args.reset) throw new Error(`ya hay un borrador ${args.from}..${existing.rows[0].to_day} (${existing.rows[0].id}); para reescribirlo hasta ${args.to} usá --reset`);
    console.log(`reset: el borrador ${existing.rows[0].id} pasa de ..${existing.rows[0].to_day} a ..${args.to}`);
  }
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
      reference: `${source} ${args.mask} ${args.from}..${args.to}`,
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
      reference: `${source} ${args.mask} ${args.from}..${args.to}`,
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

  // 5. Casamiento automático — el casador es la librería `statement-suggest` (etapas 5a–5e,
  //    2026-09-15): el mismo plan que el feed muestra como SUGERENCIA acá se aplica entero
  //    (puesta al día por script). Paridad probada por hash: e2e-bank-suggest-parity-sandbox.ts.
  const params = await loadSuggestParams(pool, {
    account_list_id: acct.qb_list_id,
    book_item_ids: context.book_items.map((b) => b.id),
    to: args.to,
    toleranceDays: args.toleranceDays,
    bpToleranceDays: args.bpToleranceDays,
  });
  const plan = suggestStatement(context, params);
  const { allocations, ambiguous } = plan;
  const canceled = params.canceled;
  let revision = context.statement.revision;
  for (let i = 0; i < allocations.length; i += 100) {
    const batch = allocations.slice(i, i + 100);
    context = await matchStatement(context.statement.id, actor.id, key(["match", context.statement.id, String(revision), String(i)]), {
      expected_revision: revision,
      allocations: batch,
    });
    revision = context.statement.revision;
  }

  // 6. Preview + reporte. La key lleva la hora: un preview es lectura y su hash sella el libro de
  // ESTE momento — keyeado sólo por revisión, una corrida sin matches nuevos replayaba el receipt
  // de días atrás y el close moría con BANKING_STATEMENT_PREVIEW_STALE (Amex jul/ago, 2026-09-15).
  const preview = await previewStatement(context.statement.id, actor.id, key(["preview", context.statement.id, String(revision), new Date().toISOString()]), {
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
    `- Apertura (${source}) ${money(opening)} · Cierre (${source}) ${money(closing)} · líneas ${context.lines.length}`,
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
