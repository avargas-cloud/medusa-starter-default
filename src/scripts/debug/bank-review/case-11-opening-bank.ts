/**
 * Case 11 · Bank opening (draft → preview → adopt) with PDF evidence.
 * Prerequisites done here and reported (both idempotent):
 *   (a) map "EPT Sandbox checking" to a QuickBooks Bank account (Manage connections → Account mapping);
 *   (b) receipt accounting setup = case 18 brought forward: cut 2026-09-01, AR "Accounts Receivable", UF "Undeposited Funds".
 * Opening: statement 10,000.00 · book 9,000.00 · outstanding check 1,000.00 (check 1042 of 2026-08-28) → difference 0 → adopt → 0 GL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, block, baseAccount, journalCount, record, type Json } from "./_lib";
import { tinyPdf } from "./_pdf";

const QB_BANK = { id: "80000006-1317847775", name: "Chase Bank Checking 7223" };
const AR = "80000047-1331073116", UF = "80000048-1331156691";
const key = (tag: string) => ({ "Idempotency-Key": `case-11-${tag}-${randomUUID()}` });

void run("case-11", async ({ api, pool }) => {
  const base = await baseAccount(api, pool);
  const account = () => api.get("/admin/banking").then(o => (o.accounts as Json[]).find(a => a.id === base.id)!);
  if (!(await account()).qb_list_id) await api.post(`/admin/banking/accounts/${base.id}`, { qb_list_id: QB_BANK.id });
  const setupBefore = record((await api.get("/admin/banking/accounting/setup")).setup);
  const setup = setupBefore?.cut_date ? setupBefore : record((await api.post("/admin/banking/accounting/setup",
    { expected_revision: Number(setupBefore?.revision ?? 0), cut_date: "2026-09-01", ar_account_list_id: AR, clearing_account_list_id: UF, local_usd_attested: true }, key("setup"))).setup) ?? {};

  const existing = ((await api.get("/admin/banking/accounting/openings")).openings as Json[] ?? []).find(o => o.kind === "bank" && o.bank_account_id === base.id && o.status !== "revoked");
  let context: Json;
  if (existing) {
    context = await api.get(`/admin/banking/accounting/openings/${existing.id}`);
  } else {
    const upload = async (name: string, text: string) => record((await api.post("/admin/banking/accounting/openings/evidence", { name, mime_type: "application/pdf", content_base64: tinyPdf(text).toString("base64") }, key("ev"))).evidence)!;
    const statement = await upload("chase-7223-statement-2026-08-31.pdf", "Chase 7223 statement 2026-08-31 · ending balance 10,000.00");
    const books = await upload("libro-banco-2026-08-31.pdf", "Book balance 2026-08-31 · 9,000.00");
    const check = await upload("check-1042.pdf", "Check 1042 · 2026-08-28 · 1,000.00 · outstanding at 08-31");
    context = await api.post("/admin/banking/accounting/openings", { expected_revision: 0, kind: "bank", bank_account_id: base.id,
      statement_balance_cents: 1_000_000, book_balance_cents: 900_000, statement_evidence_id: statement.id, books_evidence_id: books.id,
      reference: "Apertura Chase 7223 al 2026-08-31",
      items: [{ kind: "outstanding_check", original_day: "2026-08-28", amount_cents: 100_000, external_key: "chk-1042", reference: "Check 1042", description: "Cheque en tránsito al 08-31", evidence_id: check.id }] }, key("save"));
  }
  let opening = record(context.opening) ?? {};
  let preview: Json = {};
  if (opening.status === "draft") {
    preview = await api.post(`/admin/banking/accounting/openings/${opening.id}/preview`, { expected_revision: Number(opening.revision) }, key("preview"));
    const p = record(preview.preview) ?? preview;
    assert.equal(Number(p.difference_cents), 0, "statement − outstanding = book");
    const adopted = await api.post(`/admin/banking/accounting/openings/${opening.id}/adopt`, { expected_revision: Number(opening.revision), preview_hash: String(p.preview_hash), evidence_attested: true }, key("adopt"));
    opening = record(adopted.opening) ?? opening;
  }
  const final = await api.get(`/admin/banking/accounting/openings/${opening.id}`);
  const fo = record(final.opening) ?? {};
  const items = (final.items as Json[]).map(i => ({ kind: i.kind, day: i.original_day, amount_cents: i.amount_cents, reference: i.reference, cleared: i.cleared_at ?? i.status ?? null }));
  const journal = await journalCount(pool);

  assert.equal((await account()).qb_list_id, QB_BANK.id); assert.equal(setup.cut_date, "2026-09-01");
  assert.equal(fo.status, "adopted"); assert.equal(Number(fo.statement_balance_cents), 1_000_000); assert.equal(Number(fo.book_balance_cents), 900_000);
  assert.equal(items.length, 1); assert.equal(items[0]!.amount_cents, 100_000);
  assert.equal(journal, 0, "adopting an opening posts nothing");

  block("Qué hice", { prerequisites: { account_mapping: `${base.id} → QB ${QB_BANK.name} (${QB_BANK.id})`, receipt_setup_case18: { cut_date: setup.cut_date, ar: "Accounts Receivable", undeposited_funds: "Undeposited Funds", revision: setup.revision } },
    opening: { id: fo.id, kind: "bank", reference: fo.reference, statement: "10,000.00", book: "9,000.00", items: [{ outstanding_check: "1,000.00 · Check 1042 · 2026-08-28" }], evidence_pdfs: (final.evidence as Json[]).map(e => e.original_name), reused_existing: Boolean(existing) } });
  block("Qué esperamos", { preview: record(preview.preview) ?? preview, opening: { status: fo.status, revision: fo.revision, cut_date: fo.cut_date, adopted_by: fo.adopted_by, adopted_at: fo.adopted_at, difference_cents: final.difference_cents ?? null, blockers: final.blockers }, items, bank_journal_entry: journal });
  block("Mirá", "http://localhost:3099/accounting/banks/openings → apertura Bank 'Apertura Chase 7223 al 2026-08-31' adoptada, con 3 PDFs y el cheque 1042 pendiente; Banks → Manage connections → Account mapping = Chase Bank Checking 7223; Receipts → setup 2026-09-01");
});
