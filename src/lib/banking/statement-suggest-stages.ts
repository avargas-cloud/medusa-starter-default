import type { SuggestAllocation, SuggestParams, SuggestStage } from "./statement-suggest-types";
import type { StatementBookItem, StatementContext, StatementLine } from "./statement-types";

/**
 * Etapas del casador, portadas 1:1 de `reconcile-feed-statement.ts` (5a–5e, 2026-09-15). El
 * estado compartido es el `Allocator`: `remaining` lleva el resto CON SIGNO de cada asiento (el
 * motor lo entrega en valor absoluto), `matched` las líneas ya asignadas. Cada etapa sólo agrega
 * asignaciones; ninguna escribe. La paridad con el script se prueba por hash contra los
 * borradores reales (`e2e-bank-suggest-parity-sandbox.ts`).
 */
export const daysBetween = (a: string, b: string): number =>
  Math.abs((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
const daysAgo = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
export const checkNo = (text: string): string | null =>
  /\bCHECK\s*#?\s*(\d{2,7})\b/i.exec(text)?.[1] ?? null;

export class Allocator {
  readonly remaining: Map<string, number>;
  readonly matched: Set<string>;
  readonly allocations: SuggestAllocation[] = [];
  readonly stageOf = new Map<string, SuggestStage>();
  readonly ambiguous: Array<{ line: StatementLine; candidates: StatementBookItem[]; stage: SuggestStage }> = [];

  constructor(
    readonly ctx: StatementContext,
    readonly params: SuggestParams
  ) {
    this.matched = new Set(ctx.matches.map((m) => m.statement_line_id));
    this.remaining = new Map(
      ctx.book_items.map((b) => [b.id, Math.sign(b.amount_cents) * b.remaining_cents])
    );
  }
  rem(b: StatementBookItem): number {
    return Math.abs(this.remaining.get(b.id) ?? 0);
  }
  open(): StatementLine[] {
    return this.ctx.lines.filter((l) => !this.matched.has(l.id) && !l.blockers.length);
  }
  books(): StatementBookItem[] {
    return this.ctx.book_items.filter(
      (b) => !b.blockers.length && this.rem(b) !== 0 && !this.params.canceled.has(b.id)
    );
  }
  sameSide(b: StatementBookItem, l: StatementLine): boolean {
    return Math.sign(b.amount_cents) === Math.sign(l.amount_cents);
  }
  // Las partidas en tránsito de la apertura están fechadas al corte pero el banco las muestra
  // semanas después: tolerancia amplia sólo para ellas. Un BP-#### del POS (cheque sin número)
  // se cobra hasta 2-3 semanas después, siempre con candidato ÚNICO.
  within(b: StatementBookItem, l: StatementLine): boolean {
    const tolerance = /^Opening balance /.test(b.reference)
      ? 60
      : /^BP-\d+/.test(b.reference) && b.amount_cents < 0
        ? this.params.bpToleranceDays
        : this.params.toleranceDays;
    return daysBetween(b.day, l.day) <= tolerance;
  }
  bookCheckNo(b: StatementBookItem): string | null {
    return checkNo(b.reference) ?? checkNo(b.description) ?? this.params.posCheckNo.get(b.reference) ?? null;
  }
  allocate(line: StatementLine, book: StatementBookItem, amount: number, stage: SuggestStage): void {
    this.remaining.set(book.id, (this.remaining.get(book.id) ?? 0) - Math.sign(book.amount_cents) * amount);
    this.matched.add(line.id);
    if (!this.stageOf.has(line.id)) this.stageOf.set(line.id, stage);
    this.allocations.push({
      statement_line_id: line.id,
      book_kind: "journal_line",
      book_id: book.id,
      amount_cents: amount,
      expected_book_hash: book.source_hash,
    });
  }
}

/** 5a. Número de cheque: "CHECK # 796" ↔ "QB Check 796" aunque haya otros cheques del mismo monto. */
export function stageCheckNumber(a: Allocator): void {
  for (const line of a.open()) {
    const no = checkNo(line.description);
    if (!no) continue;
    const hit = a
      .books()
      .filter((b) => a.sameSide(b, line) && a.rem(b) === Math.abs(line.amount_cents) && a.bookCheckNo(b) === no);
    if (hit.length === 1) a.allocate(line, hit[0]!, Math.abs(line.amount_cents), "check_number");
  }
}

/** 5b. Monto exacto + fecha cercana, candidato único (gemelas en orden; indistinguibles = cualquiera). */
export function stageExactAmount(a: Allocator): void {
  for (const line of a.open()) {
    const candidates = a
      .books()
      .filter((b) => a.sameSide(b, line) && a.rem(b) === Math.abs(line.amount_cents) && a.within(b, line))
      .sort((x, y) => daysBetween(x.day, line.day) - daysBetween(y.day, line.day));
    if (!candidates.length) continue;
    const best = candidates[0]!;
    const tie = candidates.filter((c) => daysBetween(c.day, line.day) === daysBetween(best.day, line.day));
    if (tie.length > 1) {
      const twins = a.open().filter((l) => l.day === line.day && l.amount_cents === line.amount_cents);
      if (twins.length === tie.length) {
        twins.forEach((l, i) => a.allocate(l, tie[i]!, Math.abs(l.amount_cents), "exact_amount"));
        continue;
      }
      const same = (c: StatementBookItem): boolean =>
        c.day === best.day && c.amount_cents === best.amount_cents && c.reference === best.reference && c.description === best.description;
      if (tie.every(same)) {
        a.allocate(line, best, Math.abs(line.amount_cents), "exact_amount");
        continue;
      }
      a.ambiguous.push({ line, candidates: tie, stage: "exact_amount" });
      continue;
    }
    a.allocate(line, best, Math.abs(line.amount_cents), "exact_amount");
  }
}

/** 5c. Varias líneas del banco (mismo día primero, después ±tolerancia) = UN asiento. DFS con poda. */
export function stageBankSum(a: Allocator): void {
  const subsetSums = (pool: StatementLine[], target: number, maxSize: number): StatementLine[][] => {
    const sorted = [...pool].sort((x, y) => Math.abs(y.amount_cents) - Math.abs(x.amount_cents));
    const goal = Math.abs(target);
    const suffix = new Array<number>(sorted.length + 1).fill(0);
    for (let i = sorted.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + Math.abs(sorted[i]!.amount_cents);
    const solutions: StatementLine[][] = [];
    let visits = 0;
    const walk = (start: number, acc: StatementLine[], sum: number): void => {
      if (solutions.length > 1 || visits++ > 200_000) return;
      if (acc.length >= 2 && sum === goal) {
        solutions.push(acc);
        return;
      }
      if (acc.length === maxSize || sum + suffix[start]! < goal) return;
      for (let i = start; i < sorted.length; i++) {
        const next = sum + Math.abs(sorted[i]!.amount_cents);
        if (next > goal) continue;
        walk(i + 1, [...acc, sorted[i]!], next);
      }
    };
    walk(0, [], 0);
    if (visits > 200_000) return [];
    const signature = (sol: StatementLine[]): string => sol.map((l) => l.amount_cents).sort((x, y) => x - y).join(",");
    return solutions.length === 2 && signature(solutions[0]!) === signature(solutions[1]!) ? [solutions[0]!] : solutions;
  };
  for (const book of a.books()) {
    const target = a.remaining.get(book.id) ?? 0;
    let done = false;
    for (const window of [0, a.params.toleranceDays]) {
      const pool = a.open().filter((l) => a.sameSide(book, l) && daysBetween(l.day, book.day) <= window);
      if (pool.length < 2 || pool.length > 40) continue;
      const hit = subsetSums(pool, target, 8);
      if (hit.length === 1) {
        for (const l of hit[0]!) a.allocate(l, book, Math.abs(l.amount_cents), "bank_sum");
        done = true;
      }
      if (done || hit.length > 1) break;
    }
  }
}

/** 5d. Una línea del banco = suma NETA de varios asientos (procesadora): por día de libro, después ventanas. */
export function stageBookNet(a: Allocator): void {
  const solve = (line: StatementLine, pool: StatementBookItem[], maxSize: number): StatementBookItem[][] => {
    const solutions: StatementBookItem[][] = [];
    const walk = (start: number, acc: StatementBookItem[], sum: number): void => {
      if (solutions.length > 1) return;
      if (acc.length >= 2 && sum === line.amount_cents) {
        solutions.push(acc);
        return;
      }
      if (acc.length === maxSize) return;
      for (let i = start; i < pool.length; i++) walk(i + 1, [...acc, pool[i]!], sum + (a.remaining.get(pool[i]!.id) ?? 0));
    };
    walk(0, [], 0);
    return solutions;
  };
  for (const line of a.open()) {
    let done = false;
    for (let back = 0; back <= a.params.toleranceDays && !done; back++) {
      const d = daysAgo(line.day, back);
      const d2 = daysAgo(d, 2);
      const pool = a.books().filter((b) => b.day <= d && b.day >= d2);
      if (pool.length < 2 || pool.length > 20) continue;
      const solutions = solve(line, pool, 8);
      if (solutions.length === 1) {
        for (const b of solutions[0]!) a.allocate(line, b, a.rem(b), "book_net");
        done = true;
      }
    }
  }
  for (const line of a.open()) {
    for (const window of [1, 2, a.params.toleranceDays]) {
      const pool = a
        .books()
        .filter((b) => daysBetween(b.day, line.day) <= window)
        .sort((x, y) => x.day.localeCompare(y.day));
      if (pool.length > 40) break;
      const solutions = solve(line, pool, 5);
      if (solutions.length === 1) {
        for (const b of solutions[0]!) a.allocate(line, b, a.rem(b), "book_net");
        break;
      }
      if (solutions.length > 1) break;
    }
  }
}

/** 5e. Mismo día, misma dirección, MISMA SUMA, distinto reparto: k líneas ↔ m asientos (2..4) en orden. */
export function stageSplit(a: Allocator): void {
  for (const day of [...new Set(a.open().map((l) => l.day))]) {
    for (const sgn of [1, -1]) {
      const ls = a.open().filter((l) => l.day === day && Math.sign(l.amount_cents) === sgn);
      const bs = a.books().filter((b) => Math.sign(b.amount_cents) === sgn && daysBetween(b.day, day) <= a.params.toleranceDays);
      if (ls.length < 2 || ls.length > 4 || bs.length < 2 || bs.length > 4) continue;
      if (ls.reduce((s, l) => s + l.amount_cents, 0) !== bs.reduce((s, b) => s + (a.remaining.get(b.id) ?? 0), 0)) continue;
      let bi = 0;
      for (const l of ls) {
        let need = Math.abs(l.amount_cents);
        while (need > 0 && bi < bs.length) {
          const b = bs[bi]!;
          const take = Math.min(need, a.rem(b));
          if (take > 0) a.allocate(l, b, take, "split");
          need -= take;
          if (a.rem(b) === 0) bi++;
        }
      }
    }
  }
}
