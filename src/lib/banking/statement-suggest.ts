import type { Pool, PoolClient } from "pg";

import {
  Allocator,
  stageBankSum,
  stageBookNet,
  stageCheckNumber,
  stageExactAmount,
  stageSplit,
} from "./statement-suggest-stages";
import {
  SUGGEST_ENGINE_VERSION,
  type LineSuggestion,
  type SuggestAllocation,
  type SuggestCandidate,
  type SuggestParams,
  type SuggestPlan,
} from "./statement-suggest-types";
import type { StatementBookItem, StatementContext } from "./statement-types";

export type { LineSuggestion, SuggestAllocation, SuggestCandidate, SuggestParams, SuggestPlan } from "./statement-suggest-types";
export { SUGGEST_ENGINE_VERSION } from "./statement-suggest-types";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Parámetros que salen de la base: el puente BP-#### → nº de cheque (la copia de QB del bill
 * payment, reversada porque el POS es el dueño) y los asientos anulados al cierre. Sin el
 * puente, dos BP de $1.500 al mismo vendor se casaban CRUZADOS (TD 2026-06); sin excluir los
 * anulados, un par reversa/repost suma cero y vuelve ambiguo cualquier neteo (2026-09-14).
 */
export async function loadSuggestParams(
  db: Queryable,
  input: {
    account_list_id: string;
    book_item_ids: string[];
    to: string;
    toleranceDays?: number;
    bpToleranceDays?: number;
  }
): Promise<SuggestParams> {
  const posCheckNo = new Map<string, string>(
    (
      await db.query<{ number: string; ref: string | null }>(
        `SELECT bp.number,e.source_snapshot->>'ref_number' AS ref FROM vendor_bill_payment bp
           JOIN bank_journal_entry e ON e.source_kind='qb_import' AND e.kind='document' AND e.source_id=bp.qb_txn_id
          WHERE bp.bank_account_list_id=$1 AND bp.qb_txn_id IS NOT NULL AND bp.deleted_at IS NULL`,
        [input.account_list_id]
      )
    ).rows.flatMap((r) => (r.ref && /^\d+$/.test(r.ref) ? [[r.number, r.ref] as const] : []))
  );
  const canceled = new Set(
    (
      await db.query<{ id: string }>(
        `SELECT l.id FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id
          WHERE l.id = ANY($1::text[])
            AND (e.kind='reversal' OR EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id AND r.day<=$2))`,
        [input.book_item_ids, input.to]
      )
    ).rows.map((r) => r.id)
  );
  return {
    toleranceDays: input.toleranceDays ?? 5,
    bpToleranceDays: input.bpToleranceDays ?? 30,
    posCheckNo,
    canceled,
  };
}

/**
 * Las asignaciones con asiento de signo opuesto a su línea van primero: el trigger de capacidad
 * suma con signo y una suma parcial que arranque por el depósito excedería la línea neteada.
 */
export function orderAllocations(ctx: StatementContext, allocations: SuggestAllocation[]): SuggestAllocation[] {
  const lineSign = new Map(ctx.lines.map((l) => [l.id, Math.sign(l.amount_cents)]));
  const bookSign = new Map(ctx.book_items.map((b) => [b.id, Math.sign(b.amount_cents)]));
  return [...allocations].sort((x, y) => {
    const ox = bookSign.get(x.book_id) === lineSign.get(x.statement_line_id) ? 1 : 0;
    const oy = bookSign.get(y.book_id) === lineSign.get(y.statement_line_id) ? 1 : 0;
    return ox - oy;
  });
}

function candidate(book: StatementBookItem, amount: number): SuggestCandidate {
  return {
    book_id: book.id,
    amount_cents: amount,
    expected_book_hash: book.source_hash,
    reference: book.reference,
    description: book.description,
    day: book.day,
    book_amount_cents: book.amount_cents,
  };
}

/** Corre las cinco etapas en el orden del script y devuelve el plan. Puro: no toca la base. */
export function suggestStatement(ctx: StatementContext, params: SuggestParams): SuggestPlan {
  const a = new Allocator(ctx, params);
  stageCheckNumber(a);
  stageExactAmount(a);
  stageBankSum(a);
  stageBookNet(a);
  stageSplit(a);
  const books = new Map(ctx.book_items.map((b) => [b.id, b]));
  const already = new Set(ctx.matches.map((m) => m.statement_line_id));
  const byLine = new Map<string, LineSuggestion>();
  for (const line of ctx.lines) {
    const own = a.allocations.filter((x) => x.statement_line_id === line.id);
    if (own.length && !already.has(line.id)) {
      byLine.set(line.id, {
        line_id: line.id,
        kind: "match",
        stage: a.stageOf.get(line.id) ?? "exact_amount",
        candidates: own.map((x) => candidate(books.get(x.book_id)!, x.amount_cents)),
        alternatives: [],
      });
      continue;
    }
    // Una línea que quedó ambigua en 5b pero se asignó después (gemelas) ya tiene su match arriba.
    const amb = a.ambiguous.find((x) => x.line.id === line.id);
    if (amb && !a.matched.has(line.id)) {
      byLine.set(line.id, {
        line_id: line.id,
        kind: "ambiguous",
        stage: amb.stage,
        candidates: [],
        alternatives: amb.candidates.map((b) => candidate(b, Math.abs(line.amount_cents))),
      });
      continue;
    }
    byLine.set(line.id, { line_id: line.id, kind: "none", candidates: [], alternatives: [] });
  }
  return {
    engine_version: SUGGEST_ENGINE_VERSION,
    allocations: orderAllocations(ctx, a.allocations),
    ambiguous: a.ambiguous.filter((x) => !a.matched.has(x.line.id)).map(({ line, candidates }) => ({ line, candidates })),
    by_line: byLine,
  };
}
