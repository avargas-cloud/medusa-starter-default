import { BankingError } from "./security";
import { bankId } from "./store";
import { appendReviewEvent, runReviewCommand } from "./review-common";
import { statementCapacity, statementEditable } from "./statement-core";
import { statementContext } from "./statement-read";
import { statementMatchSchema, statementUnmatchSchema } from "./statement-types";

export async function matchStatement(id: string, actorId: string, key: string, input: unknown) {
  const body = statementMatchSchema.parse(input);
  return runReviewCommand({ actorId, key, operation: "statement_match", entityId: id, body }, async client => {
    await statementEditable(client, id, body.expected_revision);
    const context = await statementContext(client, id);
    await statementCapacity(client, "bank_statement_match", body.allocations.length);
    for (const allocation of body.allocations) {
      const line = context.lines.find(row => row.id === allocation.statement_line_id);
      const book = context.book_items.find(row => row.kind === allocation.book_kind && row.id === allocation.book_id);
      if (!line || !book || line.blockers.length || book.blockers.length || book.source_hash !== allocation.expected_book_hash)
        throw new BankingError("BANKING_STATEMENT_MATCH_SOURCE_DRIFT", 409);
      await client.query(`INSERT INTO bank_statement_match(id,statement_id,statement_line_id,book_kind,book_id,
        amount_cents,book_hash,line_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [bankId("bsm"), id, line.id, book.kind, book.id, allocation.amount_cents, book.source_hash, line.source_hash, actorId]);
    }
    await client.query("UPDATE bank_statement SET revision=revision+1,updated_at=now() WHERE id=$1", [id]);
    await appendReviewEvent(client, { entity_type: "statement", entity_id: id, actor_id: actorId,
      action: "statement_matched", details: { allocations: body.allocations, zero_gl: true } });
    return statementContext(client, id);
  });
}
export async function unmatchStatement(id: string, actorId: string, key: string, input: unknown) {
  const body = statementUnmatchSchema.parse(input);
  return runReviewCommand({ actorId, key, operation: "statement_unmatch", entityId: id, body }, async client => {
    await statementEditable(client, id, body.expected_revision);
    const result = await client.query(`UPDATE bank_statement_match SET deleted_at=now(),updated_at=now(),removed_by=$3,removed_reason=$4
      WHERE statement_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL RETURNING id`, [id, body.match_ids, actorId, body.reason]);
    if (result.rowCount !== new Set(body.match_ids).size) throw new BankingError("BANKING_STATEMENT_MATCH_NOT_FOUND", 409);
    await client.query("UPDATE bank_statement SET revision=revision+1,updated_at=now() WHERE id=$1", [id]);
    await appendReviewEvent(client, { entity_type: "statement", entity_id: id, actor_id: actorId,
      action: "statement_unmatched", details: { match_ids: body.match_ids, reason: body.reason, zero_gl: true } });
    return statementContext(client, id);
  });
}
