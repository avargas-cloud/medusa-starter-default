import { createHash } from "node:crypto";

import { z } from "zod";

import { getDbPool } from "../../api/utils/db-pool";
import { loadOccurrenceForFeed } from "../calendar/feed-expected-hints";
import { linkOccurrence, lockLinkable, pgLinkDb } from "../calendar/occurrence-link";
import { createBankCheck, createJournalEntry, postBankCheck, postJournalEntry } from "../ledger";

import { confirmFeedMatch, feedLineTarget } from "./feed-confirm-match";
import { reviewHash, withReviewLock } from "./review-common";
import { BankingError, bankingEnvSql } from "./security";
import { statementContext } from "./statement-read";
import { bankId, transaction } from "./store";

/**
 * Confirm-categoría: la línea del banco NO tiene documento en el libro y el contador eligió una
 * cuenta. Se crea el documento GL que corresponde, se postea (asiento + carril a QuickBooks por
 * `gl_document_add`, en la misma transacción que el post) y la línea queda casada contra el
 * asiento nuevo. Siempre con PREVIEW antes: el hash del preview viaja en el confirm y si algo
 * cambió (monto, fecha, cuenta, payee) es 409, no un documento distinto al que se mostró.
 *
 *   salida (cargo/cheque/gasto) → `gl_check`: kind por tipo de cuenta y nº (CreditCard → card_charge;
 *                                  Bank + nº → check; Bank sin nº → expense). QB: CheckAdd / CreditCardChargeAdd.
 *   entrada con categoría        → `gl_journal_entry` Dr banco / Cr cuenta (un `gl_check` exige total > 0).
 *                                  QB: JournalEntryAdd. Un cobro de cliente NO va por acá: eso es Record Deposits.
 */
export const feedDocumentSchema = z
  .object({
    category_list_id: z.string().min(1).max(128),
    payee_type: z.enum(["vendor", "customer", "other", "other_name"]).default("other"),
    payee_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable().optional(),
    payee_name: z.string().trim().min(1).max(500),
    number: z.string().trim().max(50).nullable().optional(),
    memo: z.string().trim().max(1000).nullable().optional(),
    /**
     * calendar-workqueue-20260917: la ocurrencia ESPERADA del Accounting Calendar que esta
     * salida liquida. Entra al preview (y a su hash, con `updated_at`) y queda `booked` en la
     * MISMA transacción que el documento — el match de la línea sigue siendo el paso de después.
     */
    occurrence_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable().optional(),
  })
  .strict();
export const feedDocumentConfirmSchema = feedDocumentSchema.extend({
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type FeedDocumentBody = z.infer<typeof feedDocumentSchema>;

export type FeedDocumentPreview = {
  transaction_id: string;
  statement_id: string;
  statement_line_id: string;
  document: "gl_check" | "gl_journal_entry";
  kind: "check" | "expense" | "card_charge" | "journal_entry";
  qb_txn_type: "Check" | "CreditCardCharge" | "JournalEntry";
  day: string;
  amount_cents: number;
  direction: "out" | "in";
  bank_account: { list_id: string; name: string; account_type: string };
  category: { list_id: string; name: string; account_type: string };
  payee: { type: "vendor" | "customer" | "other" | "other_name"; id: string | null; name: string };
  number: string | null;
  memo: string;
  lines: Array<{ account: string; debit_cents: number; credit_cents: number }>;
  occurrence: { id: string; due_date: string; expected_amount_cents: number; updated_at: string } | null;
  preview_hash: string;
};

type TxRow = {
  id: string;
  day: string;
  amount: string;
  name: string;
  status: string;
  account_type: string;
  qb_list_id: string | null;
  bank_name: string | null;
  bank_type: string | null;
};

async function loadTx(transactionId: string): Promise<TxRow> {
  const row = (
    await getDbPool().query<TxRow>(
      `SELECT t.id,t.transaction_date::text AS day,t.amount::text,t.name,t.status,a.type AS account_type,a.qb_list_id,
              q.full_name AS bank_name,q.account_type AS bank_type
         FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id AND a.deleted_at IS NULL
         JOIN bank_connection c ON c.id=a.connection_id AND c.deleted_at IS NULL AND c.environment=${bankingEnvSql()}
         LEFT JOIN qb_account q ON q.qb_list_id=a.qb_list_id AND q.deleted_at IS NULL
        WHERE t.id=$1 AND t.deleted_at IS NULL`,
      [transactionId]
    )
  ).rows[0];
  if (!row) throw new BankingError("BANKING_TRANSACTION_NOT_FOUND", 404);
  if (row.status !== "posted") throw new BankingError("BANKING_POSTED_TRANSACTION_REQUIRED", 409);
  if (!row.qb_list_id || !row.bank_type || !["Bank", "CreditCard"].includes(row.bank_type))
    throw new BankingError("BANKING_ACCOUNT_NOT_MAPPED", 409);
  return row;
}

export async function previewFeedDocument(transactionId: string, input: unknown): Promise<FeedDocumentPreview> {
  const body = feedDocumentSchema.parse(input);
  const tx = await loadTx(transactionId);
  const target = await feedLineTarget(transactionId);
  if (target.matched_cents > 0) throw new BankingError("BANKING_FEED_LINE_ALREADY_MATCHED", 409);
  const category = (
    await getDbPool().query<{ qb_list_id: string; full_name: string; account_type: string }>(
      `SELECT qb_list_id,full_name,account_type FROM qb_account WHERE qb_list_id=$1 AND is_active AND deleted_at IS NULL
         AND account_type NOT IN ('NonPosting','Bank','CreditCard')`,
      [body.category_list_id]
    )
  ).rows[0];
  if (!category) throw new BankingError("BANKING_CATEGORY_INVALID", 409);
  if (body.payee_type === "vendor") {
    const vendor = (await getDbPool().query(`SELECT 1 FROM qb_vendor WHERE id=$1 AND deleted_at IS NULL`, [body.payee_id ?? ""])).rowCount;
    if (!vendor) throw new BankingError("BANKING_COUNTERPARTY_INVALID", 409);
  }
  // Other Name de QB (qb-other-names-picker-20260916): el nombre del preview es el
  // de la tabla, así el hash cubre lo que de verdad se va a escribir.
  let payeeName = body.payee_name;
  if (body.payee_type === "other_name") {
    const other = (
      await getDbPool().query<{ name: string }>(
        `SELECT name FROM qb_other_name WHERE id=$1 AND is_active = true AND deleted_at IS NULL`,
        [body.payee_id ?? ""]
      )
    ).rows[0];
    if (!other) throw new BankingError("BANKING_COUNTERPARTY_INVALID", 409);
    payeeName = other.name;
  }
  // Plaid: positivo = sale. |monto| en centavos.
  const plaid = Math.round(Number(tx.amount) * 100);
  const amount = Math.abs(plaid);
  if (!amount) throw new BankingError("BANKING_INVALID_REQUEST");
  const direction: "out" | "in" = plaid > 0 ? "out" : "in";
  const isCard = tx.bank_type === "CreditCard";
  const number = body.number?.trim() ? body.number.trim() : null;
  const document = direction === "out" ? "gl_check" : "gl_journal_entry";
  const kind = document === "gl_journal_entry" ? "journal_entry" : isCard ? "card_charge" : number ? "check" : "expense";
  const memo = body.memo?.trim() || `feed:${tx.id}`;
  let occurrence: FeedDocumentPreview["occurrence"] = null;
  if (body.occurrence_id) {
    const occ = await loadOccurrenceForFeed(body.occurrence_id);
    if (!occ) throw new BankingError("BANKING_OCCURRENCE_NOT_FOUND", 404);
    // Sólo una salida en `gl_check` puede liquidar una ocurrencia desde acá; un bill se carga
    // en Vendor Bills y su pago casa después. Y sólo una ocurrencia sin documento.
    if (document !== "gl_check" || occ.status !== "expected" || occ.matched_id)
      throw new BankingError("BANKING_OCCURRENCE_NOT_LINKABLE", 409);
    occurrence = { id: occ.id, due_date: occ.due_date, expected_amount_cents: occ.expected_amount_cents, updated_at: occ.updated_at };
  }
  const preview: Omit<FeedDocumentPreview, "preview_hash"> = {
    transaction_id: tx.id,
    statement_id: target.statement_id,
    statement_line_id: target.statement_line_id,
    document,
    kind,
    qb_txn_type: document === "gl_journal_entry" ? "JournalEntry" : isCard ? "CreditCardCharge" : "Check",
    day: tx.day,
    amount_cents: amount,
    direction,
    bank_account: { list_id: tx.qb_list_id!, name: tx.bank_name ?? tx.qb_list_id!, account_type: tx.bank_type! },
    category: { list_id: category.qb_list_id, name: category.full_name, account_type: category.account_type },
    payee: { type: body.payee_type, id: body.payee_id ?? null, name: payeeName },
    number: document === "gl_check" && !isCard ? number : null,
    memo,
    lines:
      direction === "out"
        ? [
            { account: category.full_name, debit_cents: amount, credit_cents: 0 },
            { account: tx.bank_name ?? tx.qb_list_id!, debit_cents: 0, credit_cents: amount },
          ]
        : [
            { account: tx.bank_name ?? tx.qb_list_id!, debit_cents: amount, credit_cents: 0 },
            { account: category.full_name, debit_cents: 0, credit_cents: amount },
          ],
    occurrence,
  };
  const preview_hash = createHash("sha256")
    .update(JSON.stringify(preview))
    .digest("hex");
  return { ...preview, preview_hash };
}

export type FeedDocumentResult = {
  document: "gl_check" | "gl_journal_entry";
  document_id: string;
  doc_number: string;
  entry_id: string;
  qb: unknown;
  match: { statement_id: string; statement_line_id: string; revision: number } | { failed: string };
};

export async function confirmFeedDocument(
  transactionId: string,
  actorId: string,
  key: string,
  input: unknown
): Promise<FeedDocumentResult> {
  const body = feedDocumentConfirmSchema.parse(input);
  const { preview_hash, ...rest } = body;
  // Idempotencia por key: un segundo Confirm con la misma key devuelve el documento ya creado
  // (antes del preview, que ya vería la línea casada).
  const pool = getDbPool();
  const receiptKey = reviewHash([actorId, "feed_confirm_document", transactionId, key]);
  const prior = (
    await pool.query<{ result: FeedDocumentResult }>(`SELECT result FROM bank_review_event WHERE idempotency_key=$1`, [receiptKey])
  ).rows[0];
  if (prior) return prior.result;
  const preview = await previewFeedDocument(transactionId, rest);
  if (preview.preview_hash !== preview_hash) throw new BankingError("BANKING_FEED_PREVIEW_STALE", 409);

  const client = await pool.connect();
  let created: { document: "gl_check" | "gl_journal_entry"; document_id: string; doc_number: string; entry_id: string; qb: unknown };
  try {
    created = await transaction(client, async () => {
      if (preview.document === "gl_check") {
        const doc = await createBankCheck(
          client,
          {
            day: preview.day,
            bank_account_list_id: preview.bank_account.list_id,
            number: preview.number,
            payee_type: preview.payee.type,
            payee_id: preview.payee.id,
            payee_name: preview.payee.name,
            memo: preview.memo,
            to_be_printed: false,
            lines: [{ account_list_id: preview.category.list_id, amount_cents: BigInt(preview.amount_cents), memo: preview.payee.name }],
          },
          actorId
        );
        if (preview.occurrence) {
          const db = pgLinkDb(client);
          await lockLinkable(db, preview.occurrence.id);
          await linkOccurrence(db, preview.occurrence.id, {
            kind: "gl_check",
            documentId: doc.id,
            totalCents: preview.amount_cents,
            day: preview.day,
            actorId,
          });
        }
        const posted = await postBankCheck(client, doc.id, actorId);
        return { document: "gl_check" as const, document_id: doc.id, doc_number: doc.doc_number, entry_id: posted.entry_id, qb: (posted as { qb?: unknown }).qb ?? null };
      }
      const je = await createJournalEntry(
        client,
        {
          day: preview.day,
          memo: `${preview.payee.name} · ${preview.memo}`,
          lines: [
            { account_list_id: preview.bank_account.list_id, debit_cents: BigInt(preview.amount_cents), credit_cents: 0n, memo: preview.payee.name },
            {
              account_list_id: preview.category.list_id,
              debit_cents: 0n,
              credit_cents: BigInt(preview.amount_cents),
              memo: preview.payee.name,
              entity_type: preview.payee.type === "other" ? null : preview.payee.type,
              entity_id: preview.payee.type === "other" ? null : preview.payee.id,
              entity_name: preview.payee.type === "other" ? null : preview.payee.name,
            },
          ],
        },
        actorId
      );
      const posted = await postJournalEntry(client, je.id, actorId);
      return { document: "gl_journal_entry" as const, document_id: je.id, doc_number: je.number, entry_id: posted.entry_id, qb: (posted as { qb?: unknown }).qb ?? null };
    });
  } finally {
    client.release();
  }
  // El asiento nuevo es el candidato: se casa por el mismo camino que un Confirm-match.
  let match: FeedDocumentResult["match"];
  try {
    const bookLine = (
      await pool.query<{ id: string }>(
        `SELECT id FROM bank_journal_line WHERE entry_id=$1 AND account_list_id=$2 ORDER BY id LIMIT 1`,
        [created.entry_id, preview.bank_account.list_id]
      )
    ).rows[0];
    if (!bookLine) throw new Error("bank line of the new entry not found");
    const c = await pool.connect();
    let hash: string | undefined;
    try {
      const ctx = await transaction(c, async () => { await withReviewLock(c); return statementContext(c, preview.statement_id); });
      hash = ctx.book_items.find((b) => b.id === bookLine.id)?.source_hash;
    } finally { c.release(); }
    if (!hash) throw new Error("the new entry is not a book item of the statement");
    const m = await confirmFeedMatch(transactionId, actorId, `${key}:match`, {
      allocations: [{ book_id: bookLine.id, amount_cents: preview.amount_cents, expected_book_hash: hash }],
    });
    match = { statement_id: m.statement_id, statement_line_id: m.statement_line_id, revision: m.revision };
  } catch (error) {
    match = { failed: error instanceof Error ? error.message : String(error) };
  }
  const result: FeedDocumentResult = { ...created, match };
  await pool.query(
    `INSERT INTO bank_review_event(id,entity_type,entity_id,action,actor_id,details,idempotency_key,request_hash,result)
     VALUES($1,'command',$2,'feed_confirm_document',$3,$4::jsonb,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
    [
      bankId("bre"),
      transactionId,
      actorId,
      JSON.stringify({ preview_hash, document: created.document, document_id: created.document_id }),
      receiptKey,
      preview_hash,
      JSON.stringify(result),
    ]
  );
  return result;
}
