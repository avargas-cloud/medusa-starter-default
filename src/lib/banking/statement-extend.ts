import { z } from "zod";

import { appendReviewEvent, runReviewCommand } from "./review-common";
import { reviewDate, reviewToday } from "./review-date";
import { BankingError } from "./security";
import { statementCapacity } from "./statement-core";
import { statementContext } from "./statement-read";
import { statementLineFacts, statementRow } from "./statement-source";
import { statementCents, statementLineSchema, type StatementContext } from "./statement-types";
import { bankId } from "./store";

/**
 * Extiende un extracto en BORRADOR con el feed nuevo — expand-only. `saveStatement` reescribe
 * el documento entero: rechaza si tiene matches y soft-borra todas las líneas para re-insertarlas
 * con ids nuevos, así que "mantener el mes en curso al día" con él tiraría cada mañana los
 * matches que el contador confirmó ayer (2026-09-15). Acá, por `external_key`:
 *   - línea nueva → se inserta;
 *   - línea igual → se conserva (id, hash y matches intactos);
 *   - línea que cambió en el banco y NO está casada → se retira y se inserta la nueva;
 *   - línea que cambió o desapareció y SÍ está casada → se conserva y se cuenta en `drifted`
 *     (el contador la corrige con Correct; nada se descasa solo);
 *   - línea que desapareció y no está casada → se retira.
 * `to` sólo avanza (y nunca pasa de hoy); el cierre y los declarados se recalculan del feed.
 * Nunca un extracto cerrado: el guard de la tabla lo rechaza y acá se nombra antes.
 */
export const statementExtendSchema = z
  .object({
    to: reviewDate,
    closing_balance_cents: statementCents,
    lines: z.array(statementLineSchema).max(1000),
  })
  .strict();
export type StatementExtendInput = z.infer<typeof statementExtendSchema>;
export type StatementExtendResult = {
  context: StatementContext;
  appended: number;
  replaced: number;
  removed: number;
  drifted: number;
  unchanged: boolean;
};

type ExistingLine = {
  id: string;
  external_key: string;
  day: string;
  amount_cents: number;
  description: string;
  transaction_id: string | null;
  matched: boolean;
};

export async function extendDraftStatement(
  id: string,
  actorId: string,
  key: string,
  input: unknown
): Promise<StatementExtendResult> {
  const body = statementExtendSchema.parse(input);
  return runReviewCommand(
    { actorId, key, operation: "statement_extend", entityId: id, body },
    async (client) => {
      const row = await statementRow(client, id);
      if (row.status !== "draft") throw new BankingError("BANKING_STATEMENT_PERIOD_CLOSED", 409);
      if (body.to < row.to || body.to > reviewToday() || body.lines.some((l) => l.day < row.from || l.day > body.to))
        throw new BankingError("BANKING_STATEMENT_DATE_INVALID", 409);
      const seen = new Set<string>();
      for (const l of body.lines) {
        const k = l.external_key.toLowerCase();
        if (seen.has(k)) throw new BankingError("BANKING_STATEMENT_DUPLICATE_LINE", 409);
        seen.add(k);
      }
      const existing = (
        await client.query<ExistingLine>(
          `SELECT l.id,l.external_key,l.day::text AS day,l.amount_cents::float8 AS amount_cents,l.description,l.transaction_id,
             EXISTS(SELECT 1 FROM bank_statement_match m WHERE m.statement_line_id=l.id AND m.deleted_at IS NULL) AS matched
           FROM bank_statement_line l WHERE l.statement_id=$1 AND l.deleted_at IS NULL FOR UPDATE`,
          [id]
        )
      ).rows;
      const byKey = new Map(existing.map((l) => [l.external_key.toLowerCase(), l]));
      const same = (a: ExistingLine, b: StatementExtendInput["lines"][number]): boolean =>
        a.day === b.day && a.amount_cents === b.amount_cents && a.description === b.description && a.transaction_id === b.transaction_id;
      const toInsert: StatementExtendInput["lines"] = [];
      const toRetire: string[] = [];
      let drifted = 0;
      let replaced = 0;
      for (const line of body.lines) {
        const old = byKey.get(line.external_key.toLowerCase());
        if (!old) {
          toInsert.push(line);
          continue;
        }
        byKey.delete(line.external_key.toLowerCase());
        if (same(old, line)) continue;
        if (old.matched) {
          drifted += 1;
          continue;
        }
        toRetire.push(old.id);
        toInsert.push(line);
        replaced += 1;
      }
      let removed = 0;
      for (const gone of byKey.values()) {
        if (gone.matched) drifted += 1;
        else {
          toRetire.push(gone.id);
          removed += 1;
        }
      }
      const appended = toInsert.length - replaced;
      const unchanged = !toInsert.length && !toRetire.length && body.to === row.to && body.closing_balance_cents === row.closing_balance_cents;
      if (unchanged) return { context: await statementContext(client, id), appended: 0, replaced: 0, removed: 0, drifted, unchanged: true };
      await statementCapacity(client, "bank_statement_line", toInsert.length);
      if (toRetire.length)
        await client.query(
          `UPDATE bank_statement_line SET deleted_at=now(),updated_at=now() WHERE statement_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL`,
          [id, toRetire]
        );
      for (const line of toInsert) {
        const facts = await statementLineFacts(client, line, row.account_list_id);
        await client.query(
          `INSERT INTO bank_statement_line(id,statement_id,external_key,day,amount_cents,description,transaction_id,source_hash,source_snapshot)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [bankId("bsl"), id, line.external_key, line.day, line.amount_cents, line.description, line.transaction_id, facts.hash, JSON.stringify(facts.snapshot)]
        );
      }
      const credits = body.lines.reduce((s, l) => s + Math.max(l.amount_cents, 0), 0);
      const debits = body.lines.reduce((s, l) => s + Math.max(-l.amount_cents, 0), 0);
      if (row.opening_balance_cents + credits - debits !== body.closing_balance_cents)
        throw new BankingError("BANKING_STATEMENT_DOCUMENT_INCOMPLETE", 409);
      await client.query(
        `UPDATE bank_statement SET to_day=$2,revision=revision+1,updated_at=now(),
           payload=payload || jsonb_build_object('to',$2::text,'closing_balance_cents',$3::float8,
             'declared_line_count',$4::int,'declared_credits_cents',$5::float8,'declared_debits_cents',$6::float8)
         WHERE id=$1`,
        [id, body.to, body.closing_balance_cents, body.lines.length, credits, debits]
      );
      await appendReviewEvent(client, {
        entity_type: "statement",
        entity_id: id,
        actor_id: actorId,
        action: "statement_extended",
        details: { from_to: row.to, to: body.to, appended, replaced, removed, drifted, zero_gl: true },
      });
      return { context: await statementContext(client, id), appended, replaced, removed, drifted, unchanged: false };
    }
  );
}
