/**
 * adopt-qb-bank-documents — renumeración CRONOLÓGICA de toda la serie
 * `CHK-####` / `TR-####` (decisión del operador, 2026-09-15): nativos y
 * adoptados en una sola serie por `(day, created_at)`, sin huecos, y los
 * contadores `document_number_counter` al máximo.
 *
 * `planRenumber` es de lectura: arma el orden final mezclando los documentos
 * vivos de la tabla con los que el plan va a crear, y cuenta cuántos números
 * cambian (para el dry-run). `applyRenumber` corre DENTRO de la transacción
 * de adopción, después de insertar los nuevos: pasa todos los afectados por un
 * número temporal (`doc_number` es UNIQUE) y después asigna los definitivos,
 * actualizando SÓLO `document_number` del asiento `document` y de su `reversal`
 * (arista `renumber` del guard). `reference`/`description` no se tocan: entran
 * en el `input_hash` de los extractos cerrados (ver `guard-sql.ts`). Devuelve el
 * mapeo viejo→nuevo para el reporte y para `--revert`.
 */
import type { PoolClient } from "pg";

import type { AdoptionPlanItem } from "./apply";

type Table = "gl_check" | "gl_transfer";

export interface RenumberSlot {
  table: Table;
  /** id existente, o `plan:<índice>` para un documento que se va a crear. */
  key: string;
  day: string;
  /** `created_at` del ASIENTO (estable entre corridas; un draft sin asiento usa el del documento). */
  created_at: string;
  /** Desempate estable: id del asiento, o del documento si no tiene. */
  tie: string;
  current: string | null;
}

export interface RenumberPlan {
  checks: RenumberSlot[];
  transfers: RenumberSlot[];
  checkChanges: number;
  transferChanges: number;
  preview: Array<{ table: Table; key: string; from: string | null; to: string }>;
}

const PREFIX: Record<Table, "CHK" | "TR"> = { gl_check: "CHK", gl_transfer: "TR" };
const format = (table: Table, n: number): string => `${PREFIX[table]}-${String(n).padStart(4, "0")}`;

/**
 * Orden estable entre corridas: el `created_at` del asiento no cambia al adoptar
 * ni al renumerar (el del documento sí: un adoptado nace hoy). Sin esto, una
 * segunda corrida reordenaba los empates del mismo día y "renumeraba" 6 docs.
 */
const byChrono = (a: RenumberSlot, b: RenumberSlot) =>
  a.day.localeCompare(b.day) || a.created_at.localeCompare(b.created_at) || a.tie.localeCompare(b.tie);

export async function planRenumber(client: PoolClient, plan: AdoptionPlanItem[]): Promise<RenumberPlan> {
  const slots: Record<Table, RenumberSlot[]> = { gl_check: [], gl_transfer: [] };
  for (const table of ["gl_check", "gl_transfer"] as const) {
    const { rows } = await client.query<{ id: string; day: string; created_at: string; tie: string; doc_number: string }>(
      `SELECT d.id, d.day::text AS day, COALESCE(e.created_at, d.created_at)::text AS created_at, COALESCE(e.id, d.id) AS tie, d.doc_number
         FROM ${table} d LEFT JOIN bank_journal_entry e ON e.id = d.entry_id WHERE d.deleted_at IS NULL`
    );
    for (const r of rows) slots[table].push({ table, key: r.id, day: r.day, created_at: r.created_at, tie: r.tie, current: r.doc_number });
  }
  const { rows: entryTimes } = await client.query<{ id: string; created_at: string }>(
    `SELECT id, created_at::text AS created_at FROM bank_journal_entry WHERE id = ANY($1::text[])`,
    [plan.map((p) => p.entry.entry_id)]
  );
  const createdAt = new Map(entryTimes.map((e) => [e.id, e.created_at]));
  plan.forEach((item, index) => {
    if (item.decision.target === "unmapped") return;
    slots[item.decision.target].push({
      table: item.decision.target,
      key: `plan:${index}`,
      day: item.entry.day,
      created_at: createdAt.get(item.entry.entry_id) ?? "",
      tie: item.entry.entry_id,
      current: null,
    });
  });
  const out: RenumberPlan = { checks: [], transfers: [], checkChanges: 0, transferChanges: 0, preview: [] };
  for (const table of ["gl_check", "gl_transfer"] as const) {
    const ordered = slots[table].sort(byChrono);
    ordered.forEach((slot, i) => {
      const to = format(table, i + 1);
      if (slot.current !== to) {
        if (table === "gl_check") out.checkChanges += 1;
        else out.transferChanges += 1;
        if (slot.current) out.preview.push({ table, key: slot.key, from: slot.current, to });
      }
    });
    if (table === "gl_check") out.checks = ordered;
    else out.transfers = ordered;
  }
  return out;
}

const SOURCE_KIND: Record<Table, "bank_check" | "bank_transfer"> = { gl_check: "bank_check", gl_transfer: "bank_transfer" };

/** Re-etiqueta `document_number` del asiento `document` del documento y de su `reversal` si la hay (arista renumber). */
export async function relabelJournal(client: PoolClient, table: Table, id: string): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE bank_journal_entry e SET document_number = d.doc_number, updated_at = now()
       FROM ${table} d
      WHERE d.id = $2 AND e.source_kind = $1 AND e.source_id = d.id AND e.kind IN ('document','reversal')
        AND e.document_number IS DISTINCT FROM d.doc_number`,
    [SOURCE_KIND[table], id]
  );
  return rowCount ?? 0;
}

export interface RenumberResult {
  renumbered: number;
  map: Array<{ table: Table; id: string; from: string; to: string }>;
}

/**
 * Asigna los números definitivos. `resolveKey` traduce `plan:<i>` al id creado.
 * Debe correr con la transacción abierta (el caller la maneja).
 */
export async function applyRenumber(
  client: PoolClient,
  plan: RenumberPlan,
  resolveKey: (key: string) => string
): Promise<RenumberResult> {
  const result: RenumberResult = { renumbered: 0, map: [] };
  for (const table of ["gl_check", "gl_transfer"] as const) {
    const ordered = table === "gl_check" ? plan.checks : plan.transfers;
    const targets = ordered.map((slot, i) => ({ id: resolveKey(slot.key), current: slot.current, to: format(table, i + 1) }));
    const changing = targets.filter((t) => t.current !== t.to);
    if (!changing.length) continue;
    // 1) número temporal para todos los que cambian (UNIQUE sin colisiones intermedias)
    await client.query(`UPDATE ${table} SET doc_number = 'tmp:' || id WHERE id = ANY($1::text[])`, [changing.map((t) => t.id)]);
    // 2) definitivo + asiento
    for (const t of changing) {
      await client.query(`UPDATE ${table} SET doc_number = $2, updated_at = now() WHERE id = $1`, [t.id, t.to]);
      await relabelJournal(client, table, t.id);
      result.renumbered += 1;
      if (t.current) result.map.push({ table, id: t.id, from: t.current, to: t.to });
    }
    await client.query(`UPDATE document_number_counter SET value = $2, updated_at = now() WHERE name = $1`, [table, ordered.length]);
  }
  return result;
}
