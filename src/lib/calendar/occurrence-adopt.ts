/**
 * src/lib/calendar/occurrence-adopt.ts
 *
 * Adopción AUTOMÁTICA y determinista de documentos que ya existen: una
 * ocurrencia `expected` se enlaza al documento que evidentemente es ella
 * — mismo payee, monto dentro de la tolerancia, fecha a ≤ ADOPT_DAYS días,
 * la cuenta de gasto de la regla en alguna línea, y la cuenta pagadora como
 * preferencia (misma primero; cualquiera si no hay) — **sólo si el candidato
 * es ÚNICO**. Con 0 candidatos queda
 * expected; con 2+ tampoco adivina: los devuelve como `ambiguous` para que la
 * pantalla lo diga y el contador decida.
 *
 * Corre al final de `materializeAll` (job diario), tras crear una regla, y en
 * el seed inicial. Nunca toca una ocurrencia que ya tiene documento ni una
 * paid/skipped, y nunca enlaza un documento que otra ocurrencia ya reclamó
 * (el índice único parcial lo garantiza; acá se filtra antes para no
 * reventar la transacción).
 *
 * Bindings knex `?` (los callers traen `__pg_connection__`).
 */
import type { RawPg } from "./recurring-repo";

/** Distancia máxima entre la fecha del documento y el vencimiento. */
export const ADOPT_DAYS = 7;

export interface AdoptCandidate {
  kind: "gl_check" | "vendor_bill" | "gl_transfer";
  id: string;
  doc_number: string;
  day: string;
  total_cents: number;
}

export interface AdoptResult {
  scanned: number;
  adopted: Array<{ occurrence_id: string; rule_name: string; due_date: string; document: AdoptCandidate }>;
  ambiguous: Array<{ occurrence_id: string; rule_name: string; due_date: string; candidates: AdoptCandidate[] }>;
}

type OccRow = {
  id: string;
  rule_name: string;
  due_date: string;
  document_kind: string | null;
  expected_amount_cents: string;
  tolerance: string;
  payee_type: string | null;
  payee_id: string | null;
  /** Payee sin espacios ni puntuación, en mayúsculas: "RingCentral" ≡ "Ring Central", "AT&T" ≡ "ATT". */
  payee_squash: string | null;
  expense_account_list_id: string | null;
  pay_from_account_list_id: string | null;
};

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * Candidatos `gl_check` de una ocurrencia check/expense. Todo el criterio vive
 * en este SQL. La cuenta pagadora es PREFERENCIA, no filtro: primero se busca
 * con la misma cuenta y, si no hay ninguno, con cualquiera — el 15 de
 * septiembre los contratistas salieron de TD cuando la regla decía Regions, y
 * payee + monto + fecha ya identifican el cheque.
 */
async function checkCandidates(pg: RawPg, o: OccRow): Promise<AdoptCandidate[]> {
  const sameBank = await checkCandidatesWithBank(pg, o, o.pay_from_account_list_id);
  if (sameBank.length || !o.pay_from_account_list_id) return sameBank;
  return checkCandidatesWithBank(pg, o, null);
}

async function checkCandidatesWithBank(pg: RawPg, o: OccRow, bank: string | null): Promise<AdoptCandidate[]> {
  const res = await pg.raw(
    `SELECT c.id, c.doc_number, c.day::text AS day, c.total_cents::text AS total_cents
       FROM gl_check c
      WHERE c.deleted_at IS NULL AND c.status <> 'voided'
        AND abs(c.total_cents - ?::bigint) <= ?::bigint
        AND abs(c.day - ?::date) <= ?
        AND (?::text IS NULL OR c.bank_account_list_id = ?)
        AND (
          (?::text IS NOT NULL AND c.payee_id = ?)
          OR regexp_replace(upper(c.payee_name), '[^A-Z0-9]', '', 'g') = ?
        )
        AND (?::text IS NULL OR EXISTS (SELECT 1 FROM gl_check_line l WHERE l.check_id = c.id AND l.account_list_id = ?))
        AND NOT EXISTS (SELECT 1 FROM recurring_expense_occurrence x WHERE x.matched_kind = 'gl_check' AND x.matched_id = c.id)
      ORDER BY abs(c.day - ?::date), c.day, c.id`,
    [
      o.expected_amount_cents, o.tolerance, o.due_date, ADOPT_DAYS,
      bank, bank,
      o.payee_id, o.payee_id, o.payee_squash || "__NO_PAYEE__",
      o.expense_account_list_id, o.expense_account_list_id,
      o.due_date,
    ]
  );
  return res.rows.map((r) => ({ kind: "gl_check", id: String(r.id), doc_number: String(r.doc_number), day: iso(r.day), total_cents: Number(r.total_cents) }));
}

/** Candidatos `vendor_bill` (expense/service) de una ocurrencia bill: por vendor, total de líneas y fecha del documento. */
async function billCandidates(pg: RawPg, o: OccRow): Promise<AdoptCandidate[]> {
  if (!o.payee_id) return [];
  const res = await pg.raw(
    `SELECT vb.id, vb.number AS doc_number, vb.document_date::date::text AS day, t.total::text AS total_cents
       FROM vendor_bill vb
       JOIN LATERAL (
         SELECT COALESCE(SUM(l.amount_cents), 0)::bigint AS total
           FROM vendor_bill_line l WHERE l.vendor_bill_id = vb.id AND l.deleted_at IS NULL
       ) t ON true
      WHERE vb.deleted_at IS NULL AND vb.status NOT IN ('deleted', 'cancelled', 'voided')
        AND vb.bill_type IN ('expense', 'service')
        AND vb.vendor_id = ?
        AND vb.document_date IS NOT NULL
        AND abs(t.total - ?::bigint) <= ?::bigint
        AND abs(vb.document_date::date - ?::date) <= ?
        AND NOT EXISTS (SELECT 1 FROM recurring_expense_occurrence x WHERE x.matched_kind = 'vendor_bill' AND x.matched_id = vb.id)
      ORDER BY abs(vb.document_date::date - ?::date), vb.document_date, vb.id`,
    [o.payee_id, o.expected_amount_cents, o.tolerance, o.due_date, ADOPT_DAYS, o.due_date]
  );
  return res.rows.map((r) => ({ kind: "vendor_bill", id: String(r.id), doc_number: String(r.doc_number ?? r.id), day: iso(r.day), total_cents: Number(r.total_cents) }));
}

/** Candidatos `gl_transfer` de una ocurrencia transfer: origen + destino + monto + fecha. */
async function transferCandidates(pg: RawPg, o: OccRow): Promise<AdoptCandidate[]> {
  if (!o.pay_from_account_list_id || !o.expense_account_list_id) return [];
  const res = await pg.raw(
    `SELECT t.id, t.doc_number, t.day::text AS day, t.amount_cents::text AS total_cents
       FROM gl_transfer t
      WHERE t.deleted_at IS NULL AND t.status <> 'voided'
        AND t.from_account_list_id = ? AND t.to_account_list_id = ?
        AND abs(t.amount_cents - ?::bigint) <= ?::bigint
        AND abs(t.day - ?::date) <= ?
        AND NOT EXISTS (SELECT 1 FROM recurring_expense_occurrence x WHERE x.matched_kind = 'gl_transfer' AND x.matched_id = t.id)
      ORDER BY abs(t.day - ?::date), t.day, t.id`,
    [o.pay_from_account_list_id, o.expense_account_list_id, o.expected_amount_cents, o.tolerance, o.due_date, ADOPT_DAYS, o.due_date]
  );
  return res.rows.map((r) => ({ kind: "gl_transfer", id: String(r.id), doc_number: String(r.doc_number), day: iso(r.day), total_cents: Number(r.total_cents) }));
}

export async function candidatesFor(pg: RawPg, o: OccRow): Promise<AdoptCandidate[]> {
  const kind = o.document_kind ?? "expense";
  if (kind === "bill") return billCandidates(pg, o);
  if (kind === "transfer") return transferCandidates(pg, o);
  return checkCandidates(pg, o);
}

/**
 * Adopta lo que sea inequívoco entre las ocurrencias `expected` sin enlace con
 * `due_date` en [from, to]. `dryRun` devuelve el mismo reporte sin escribir.
 */
export async function adoptExistingDocuments(
  pg: RawPg,
  from: string,
  to: string,
  opts: { dryRun?: boolean; actorId?: string; ruleId?: string | null } = {}
): Promise<AdoptResult> {
  const occs = await pg.raw(
    `SELECT o.id, r.name AS rule_name, o.due_date::text AS due_date, o.document_kind,
            o.expected_amount_cents::text AS expected_amount_cents,
            GREATEST(o.tolerance_cents, round(o.expected_amount_cents * o.tolerance_pct / 100))::bigint::text AS tolerance,
            o.payee_type, o.payee_id,
            regexp_replace(upper(o.payee_name), '[^A-Z0-9]', '', 'g') AS payee_squash,
            o.expense_account_list_id, o.pay_from_account_list_id
       FROM recurring_expense_occurrence o
       JOIN recurring_expense_rule r ON r.id = o.rule_id
      WHERE o.status = 'expected' AND o.matched_id IS NULL AND o.due_date BETWEEN ? AND ?
        AND (?::text IS NULL OR o.rule_id = ?)
      ORDER BY o.due_date, o.id`,
    [from, to, opts.ruleId ?? null, opts.ruleId ?? null]
  );
  const taken = new Set<string>();
  const result: AdoptResult = { scanned: occs.rows.length, adopted: [], ambiguous: [] };
  // Dos pasadas: lo que la primera enlaza deja de ser candidato para la segunda
  // (dos cargos del mismo día, 44.95 y 34.95, con tolerancias que se solapan —
  // el más chico es único, el más grande queda solo cuando el chico ya se fue).
  let pending = occs.rows.map((raw) => raw as unknown as OccRow);
  for (let pass = 0; pass < 2 && pending.length; pass++) {
    const stillAmbiguous: Array<{ o: OccRow; candidates: AdoptCandidate[] }> = [];
    // En dry-run nada se escribe, así que los documentos "tomados" en esta corrida se recuerdan acá.
    for (const o of pending) {
      const candidates = (await candidatesFor(pg, o)).filter((c) => !taken.has(`${c.kind}:${c.id}`));
      if (candidates.length === 0) continue;
      if (candidates.length > 1) {
        stillAmbiguous.push({ o, candidates });
        continue;
      }
      const doc = candidates[0];
      if (!doc) continue;
      if (!opts.dryRun) {
        // Mismo contrato que `linkOccurrence`; condicionado a que siga expected y
        // el documento siga libre (dos corridas concurrentes no pueden doblar).
        const upd = await pg.raw(
          `UPDATE recurring_expense_occurrence SET
             status = 'booked', matched_kind = ?, matched_id = ?, actual_amount_cents = ?, actual_date = ?,
             updated_by_user_id = ?, updated_at = now()
           WHERE id = ? AND status = 'expected' AND matched_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM recurring_expense_occurrence x WHERE x.matched_kind = ? AND x.matched_id = ?)
           RETURNING id`,
          [doc.kind, doc.id, doc.total_cents, doc.day, opts.actorId ?? "adopt", o.id, doc.kind, doc.id]
        );
        if (upd.rows.length !== 1) continue;
      }
      taken.add(`${doc.kind}:${doc.id}`);
      result.adopted.push({ occurrence_id: o.id, rule_name: o.rule_name, due_date: o.due_date, document: doc });
    }
    pending = stillAmbiguous.map((x) => x.o);
    if (pass === 1) {
      for (const x of stillAmbiguous) result.ambiguous.push({ occurrence_id: x.o.id, rule_name: x.o.rule_name, due_date: x.o.due_date, candidates: x.candidates });
    }
  }
  return result;
}
