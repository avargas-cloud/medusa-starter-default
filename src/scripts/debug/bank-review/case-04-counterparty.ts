/**
 * Case 04 · From/To with an existing vendor. The operator set "FPL" by hand from the row panel;
 * this script VERIFIES that state and proves the lookup only offers existing parties and never creates one.
 * The only write is a rejected request (unknown vendor id) that persists nothing.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { run, block, baseAccount, journalCount, record, type Json } from "./_lib";

void run("case-04", async ({ api, pool }) => {
  const tx = (await baseAccount(api, pool)).utilities; assert(tx, "utilities movement present");
  const review = record(tx.review) ?? {};
  assert.equal(review.counterparty_type, "vendor", "From/To is a vendor");
  const vendor = (await pool.query<{ id: string; full_name: string; is_active: boolean; created_at: Date }>(
    "SELECT id,full_name,is_active,created_at FROM qb_vendor WHERE id=$1 AND deleted_at IS NULL", [String(review.counterparty_id)])).rows[0];
  assert(vendor?.is_active, "the counterparty is an existing ACTIVE QuickBooks vendor");
  assert.equal(review.counterparty_name, vendor.full_name);

  const parties = await api.get("/admin/banking/lookups/parties?q=FPL");
  const offered = (parties.parties as Json[]) ?? (parties.results as Json[]) ?? [];
  assert(offered.some(p => p.id === vendor.id), "lookup offers the existing vendor");
  const vendorsBefore = Number((await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM qb_vendor WHERE deleted_at IS NULL")).rows[0]?.n);
  const rejected = await api.call(`/admin/banking/transactions/${tx.id}/review`, { method: "POST", allow: [400, 404, 409],
    headers: { "Idempotency-Key": `case-04-${randomUUID()}` },
    body: { mode: "categorize", category_list_id: review.category_list_id, counterparty_type: "vendor", counterparty_id: "qbvnd_00000000000000000000000000",
      comment: String(review.comment ?? ""), expected_revision: Number(review.revision), expected_source_version: Number(tx.source_version) } });
  const vendorsAfter = Number((await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM qb_vendor WHERE deleted_at IS NULL")).rows[0]?.n);
  const after = record((await baseAccount(api, pool)).utilities!.review) ?? {};
  assert(rejected.status >= 400, "unknown vendor is rejected");
  assert.equal(vendorsAfter, vendorsBefore, "no vendor was created");
  assert.equal(after.revision, review.revision, "the rejected request changed nothing");
  assert.equal(after.counterparty_id, vendor.id);
  assert.equal(await journalCount(pool), 0);

  block("Qué hice", { transaction_id: tx.id, operator_set_by_hand: { counterparty: `${review.counterparty_type} · ${review.counterparty_name}`, vendor_id: vendor.id, vendor_since: vendor.created_at },
    script_writes: "none persisted — one rejected POST with an unknown vendor id", lookup: "GET /admin/banking/lookups/parties?q=FPL" });
  block("Qué esperamos", { review: { revision: review.revision, status: review.status, category: record(review.category_snapshot)?.name, counterparty_type: review.counterparty_type, counterparty_name: review.counterparty_name },
    lookup_offers_existing_vendor: true, lookup_count_for_FPL: parties.count ?? offered.length, offered_names: offered.map(p => `${p.type}:${p.name}`).slice(0, 8),
    unknown_vendor: { status: rejected.status, code: rejected.body.code }, qb_vendor_count: { before: vendorsBefore, after: vendorsAfter }, bank_journal_entry: 0 });
  block("Mirá", "http://localhost:3099/accounting/banks → fila 2026-09-02 · From / To = FPL; al abrir el buscador, sólo terceros existentes de QB/Medusa, sin 'crear nuevo'");
});
