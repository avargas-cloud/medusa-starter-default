/**
 * src/lib/calendar/occurrence-link.ts
 *
 * Escrituras de ESTADO de una ocurrencia del Accounting Calendar: las del
 * contador (paid / skipped / reopen / mover de día) y las que hace un
 * DOCUMENTO al nacer o morir (enlace / desenlace).
 *
 * El enlace vive en la MISMA transacción que el documento: `lockLinkable`
 * toma la fila `FOR UPDATE`, y dos documentos concurrentes desde la misma
 * ocurrencia terminan 1 × 201 + 1 × 409 — no dos cheques. El desenlace es
 * condicional (`status = 'booked'` y el mismo documento): anular un check
 * nunca reabre una ocurrencia que ya fue re-enlazada o marcada a mano.
 *
 * Los dos callers hablan dialectos distintos (`pg` con `$n`, knex con `?`):
 * el SQL de acá va en `$n` en orden y `knexLinkDb` lo traduce.
 */
import type { PoolClient } from "pg";

import { OCCURRENCE_COLS, type RawPg, getOccurrence, rowToOccurrence } from "./recurring-repo";
import type { MatchedKind, OccurrencePatch, RecurringOccurrence } from "./recurring-types";

export type OccurrenceErrorCode =
  | "OCCURRENCE_NOT_FOUND"
  | "OCCURRENCE_LINKED"
  | "OCCURRENCE_NOT_MOVABLE"
  | "OCCURRENCE_NOT_LINKABLE";

export class OccurrenceError extends Error {
  constructor(
    public readonly code: OccurrenceErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** HTTP status de cada código: 404 si no existe, 409 si el estado no lo permite. */
export function occurrenceErrorStatus(code: OccurrenceErrorCode): number {
  return code === "OCCURRENCE_NOT_FOUND" ? 404 : 409;
}

/** Conexión mínima con placeholders `$n` (un `PoolClient` la cumple tal cual). */
export type LinkDb = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** Adapta un handle knex (`?`) al contrato `$n` de este módulo. */
export function knexLinkDb(knex: { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> }): LinkDb {
  return {
    query: async (sql, params) => {
      const res = await knex.raw(sql.replace(/\$\d+/g, "?"), params);
      return { rows: res.rows as Record<string, unknown>[] };
    },
  };
}

export function pgLinkDb(client: PoolClient): LinkDb {
  return { query: (sql, params) => client.query(sql, params) };
}

// ── contador ─────────────────────────────────────────────────────────────────

/**
 * Marcar pagada / saltada / volver a esperada. Una ocurrencia ENLAZADA no
 * vuelve a `expected` ni se salta por acá: primero se anula/borra el
 * documento, que es quien la desenlaza. Marcarla `paid` a mano sí se permite
 * y conserva el enlace.
 */
export async function patchOccurrence(
  pg: RawPg,
  id: string,
  patch: OccurrencePatch,
  actorId: string
): Promise<RecurringOccurrence | null> {
  const current = await getOccurrence(pg, id);
  if (!current) return null;
  if (current.matched_id && patch.status !== "paid") {
    throw new OccurrenceError("OCCURRENCE_LINKED", "This occurrence is linked to a document — void or delete it first");
  }
  const res = await pg.raw(
    `UPDATE recurring_expense_occurrence SET
       status = ?, actual_amount_cents = ?, actual_date = ?, note = ?,
       updated_by_user_id = ?, updated_at = now()
     WHERE id = ?
     RETURNING ${OCCURRENCE_COLS}`,
    [patch.status, patch.actual_amount_cents, patch.actual_date, patch.note, actorId, id]
  );
  return res.rows[0] ? rowToOccurrence(res.rows[0]) : null;
}

/** Mover UNA ocurrencia de día (sólo `expected`); la regla no se toca. */
export async function moveOccurrence(
  pg: RawPg,
  id: string,
  dueDate: string,
  actorId: string
): Promise<RecurringOccurrence | null> {
  const current = await getOccurrence(pg, id);
  if (!current) return null;
  if (current.status !== "expected") {
    throw new OccurrenceError("OCCURRENCE_NOT_MOVABLE", "Only an expected occurrence can be moved");
  }
  const res = await pg.raw(
    `UPDATE recurring_expense_occurrence SET
       due_date = ?, due_date_override = true, updated_by_user_id = ?, updated_at = now()
     WHERE id = ? AND status = 'expected'
     RETURNING ${OCCURRENCE_COLS}`,
    [dueDate, actorId, id]
  );
  return res.rows[0] ? rowToOccurrence(res.rows[0]) : null;
}

// ── documento ────────────────────────────────────────────────────────────────

/**
 * Toma la ocurrencia `FOR UPDATE` y exige que pueda originar un documento:
 * `expected` y sin enlace. Llamar DENTRO de la transacción del documento.
 */
export async function lockLinkable(db: LinkDb, id: string): Promise<RecurringOccurrence> {
  const res = await db.query(`SELECT ${OCCURRENCE_COLS} FROM recurring_expense_occurrence WHERE id = $1 FOR UPDATE`, [
    id,
  ]);
  const row = res.rows[0];
  if (!row) throw new OccurrenceError("OCCURRENCE_NOT_FOUND", "Occurrence not found");
  const occ = rowToOccurrence(row);
  if (occ.status !== "expected" || occ.matched_id) {
    throw new OccurrenceError(
      "OCCURRENCE_NOT_LINKABLE",
      occ.matched_id
        ? "This occurrence already has a document"
        : `This occurrence is ${occ.status}, not expected`
    );
  }
  return occ;
}

export interface LinkInput {
  kind: MatchedKind;
  documentId: string;
  totalCents: number;
  day: string;
  actorId: string;
}

/** `expected` → `booked` con el documento y su monto/fecha reales. Tras `lockLinkable`. */
export async function linkOccurrence(db: LinkDb, id: string, input: LinkInput): Promise<void> {
  const res = await db.query(
    `UPDATE recurring_expense_occurrence SET
       status = 'booked', matched_kind = $1, matched_id = $2, actual_amount_cents = $3, actual_date = $4,
       updated_by_user_id = $5, updated_at = now()
     WHERE id = $6 AND status = 'expected' AND matched_id IS NULL
     RETURNING id`,
    [input.kind, input.documentId, input.totalCents, input.day, input.actorId, id]
  );
  if (res.rows.length !== 1) {
    throw new OccurrenceError("OCCURRENCE_NOT_LINKABLE", "This occurrence already has a document");
  }
}

/**
 * El documento murió (void / delete / cancel): la ocurrencia vuelve a
 * `expected` SOLO si sigue `booked` con ESE documento. Devuelve cuántas
 * reabrió (0 ó 1); nunca lanza — el documento ya se anuló.
 */
export async function unlinkByDocument(
  db: LinkDb,
  kind: MatchedKind,
  documentId: string,
  reason: string
): Promise<number> {
  // Los `$n` van en ORDEN de aparición: el adaptador knex los traduce posicionalmente.
  const res = await db.query(
    `UPDATE recurring_expense_occurrence SET
       status = 'expected', matched_kind = NULL, matched_id = NULL, actual_amount_cents = NULL, actual_date = NULL,
       note = left(concat_ws(' · ', NULLIF(note, ''), $1::text), 500), updated_at = now()
     WHERE matched_kind = $2 AND matched_id = $3 AND status = 'booked'
     RETURNING id`,
    [reason, kind, documentId]
  );
  return res.rows.length;
}
