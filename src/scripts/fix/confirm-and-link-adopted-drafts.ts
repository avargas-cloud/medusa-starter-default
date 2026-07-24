/**
 * confirm-and-link-adopted-drafts.ts
 *
 * Owner mandate (2026-07-23): POS draft bills whose QB equivalent was already
 * hand-entered by the accountant were NEVER confirmed in the POS → landed
 * cost/AVCO ("el promedio") never ran for that merchandise. After the
 * reconciliation `apply` adopted those QB bills as read-only stubs, this
 * script — per adopted PO that has a matching POS regular DRAFT:
 *
 *   1. Enriches the draft's missing `reference_id` from the adopted stub's
 *      `qb_ref_number` (the vendor's real invoice #, satisfies the
 *      vendor_reference_required confirm guard with true data).
 *   2. Confirms any DRAFT service/freight/tariff bills LINKED from the draft
 *      (their totals feed the landed pools) via the real light-confirm route.
 *   3. Confirms the regular draft via the REAL receipt-confirm route handler
 *      invoked IN-PROCESS (zero AVCO reimplementation — same code the POS
 *      button runs: landed allocation, chronological AVCO replay, VB number).
 *   4. Links: stamps the QB identity (txn_id/ref/edit_sequence) + `qb_source
 *      ='adopted'` + status='synced' onto the now-confirmed draft, and
 *      soft-deletes the redundant adopted stub for that PO.
 *
 * SAFE ORDERING: must run while QB_VENDOR_BILL_MODE != 'bill' — confirming
 * with the flag off enqueues NOTHING to QB (verified: enqueueQbVendorBillAdd
 * returns {queued:false} on flag-off), so the hand-entered QB bill is never
 * duplicated. The final stamped row is read-only per the adopted guards.
 *
 * Modes: dry-run (default) reports the per-PO plan + guard prechecks
 * (reference, receipts, missing-CBM counts). `apply` executes. Positional
 * args only (medusa exec eats --flags).
 *
 * NOTE: src/scripts is EXCLUDED from yarn type-check (tsconfig) — this file
 * is validated by running it (dry-run) — see memory
 * project_backend_scripts_excluded_from_typecheck.
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { POST as confirmRegularPOST } from "../../api/admin/purchase-orders/[id]/receipts/[receiptId]/vendor-bill/confirm/route";
import { POST as confirmLightPOST } from "../../api/admin/vendor-bills/[id]/confirm/route";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

interface StubRow {
  id: string;
  purchase_order_id: string;
  qb_txn_id: string | null;
  qb_ref_number: string | null;
  qb_edit_sequence: string | null;
  document_date: string | null;
}

interface DraftRow {
  id: string;
  bill_type: string;
  status: string;
  reference_id: string | null;
  service_vendor_bill_id: string | null;
  freight_vendor_bill_id: string | null;
  tariff_vendor_bill_id: string | null;
}

/** Minimal req/res doubles that satisfy exactly what the two route handlers
 * read: scope, params, body, auth_context.actor_id / status().json(). */
function makeRes(): {
  res: unknown;
  result: () => { status: number; body: unknown };
} {
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  };
  return { res, result: () => ({ status: statusCode, body }) };
}

export default async function confirmAndLinkAdoptedDrafts({
  container,
  args,
}: ExecArgs): Promise<void> {
  const apply = (args ?? []).includes("apply");
  const knex = container.resolve("__pg_connection__") as unknown as Knex;

  // Actor for the confirm audit trail: the newest active admin user.
  const actorRows = (await knex.raw(
    `SELECT id FROM "user" WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`
  )).rows as Array<{ id: string }>;
  const actorId = actorRows[0]?.id;
  if (!actorId) throw new Error("No admin user found for the audit trail");

  const makeReq = (params: Record<string, string>, body: unknown) => ({
    scope: container,
    params,
    body,
    auth_context: { actor_id: actorId },
    query: {},
  });

  const stubs = (await knex.raw(
    `SELECT id, purchase_order_id, qb_txn_id, qb_ref_number, qb_edit_sequence, document_date
       FROM vendor_bill
      WHERE qb_source = 'adopted' AND deleted_at IS NULL
      ORDER BY purchase_order_id`
  )).rows as StubRow[];

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"} — ${stubs.length} adopted stub(s)\n`);

  let confirmed = 0;
  let skippedNoDraft = 0;
  let failures = 0;

  // A PO with MULTIPLE adopted QB bills but a single POS draft is ambiguous —
  // blind-linking could stamp the WRONG TxnID (seen: PO-1041, two All Star
  // bills $696 vs $3,960, one draft). Those are resolved by hand.
  const stubsPerPo = new Map<string, number>();
  for (const st of stubs) {
    stubsPerPo.set(st.purchase_order_id, (stubsPerPo.get(st.purchase_order_id) ?? 0) + 1);
  }

  for (const stub of stubs) {
    if ((stubsPerPo.get(stub.purchase_order_id) ?? 0) > 1) {
      const hasDraft = ((await knex.raw(
        `SELECT 1 FROM vendor_bill WHERE purchase_order_id = ? AND deleted_at IS NULL
           AND COALESCE(qb_source,'') <> 'adopted' AND bill_type='regular' AND status='draft' LIMIT 1`,
        [stub.purchase_order_id]
      )).rows.length > 0);
      if (hasDraft) {
        console.log(`⚠️  PO with MULTIPLE adopted QB bills + a draft — ambiguous mapping, SKIPPED for manual resolution (stub ${stub.qb_ref_number ?? stub.id})`);
        failures++;
        continue;
      }
    }
    const poRows = (await knex.raw(
      `SELECT number FROM purchase_order WHERE id = ? AND deleted_at IS NULL`,
      [stub.purchase_order_id]
    )).rows as Array<{ number: string | null }>;
    const poNumber = poRows[0]?.number ?? stub.purchase_order_id;

    const drafts = (await knex.raw(
      `SELECT id, bill_type, status, reference_id,
              service_vendor_bill_id, freight_vendor_bill_id, tariff_vendor_bill_id
         FROM vendor_bill
        WHERE purchase_order_id = ?
          AND deleted_at IS NULL
          AND COALESCE(qb_source,'') <> 'adopted'
          AND bill_type = 'regular'
          AND status = 'draft'`,
      [stub.purchase_order_id]
    )).rows as DraftRow[];

    if (drafts.length === 0) {
      skippedNoDraft++;
      continue;
    }
    if (drafts.length > 1) {
      console.log(`⚠️  ${poNumber}: ${drafts.length} regular drafts — ambiguous, SKIPPED (resolve by hand)`);
      failures++;
      continue;
    }
    const draft = drafts[0]!;

    // Prechecks (informational in dry-run).
    const receiptRows = (await knex.raw(
      `SELECT id FROM purchase_order_receipt
        WHERE purchase_order_id = ? AND deleted_at IS NULL
          AND status IN ('applied','synced')
        ORDER BY received_at ASC, seq ASC LIMIT 1`,
      [stub.purchase_order_id]
    )).rows as Array<{ id: string }>;
    const firstReceiptId = receiptRows[0]?.id ?? null;

    const cbmMissing = (await knex.raw(
      `SELECT count(*)::int AS n
         FROM vendor_bill_line l
         LEFT JOIN product_variant pv ON pv.id = l.product_variant_id
        WHERE l.vendor_bill_id = ? AND l.deleted_at IS NULL
          AND COALESCE(l.line_type,'product') = 'product'
          AND NULLIF(pv.metadata->>'cbm','') IS NULL`,
      [draft.id]
    )).rows[0] as { n: number };

    const refToUse = draft.reference_id?.trim() || stub.qb_ref_number || null;

    const linkedDraftIds: string[] = [];
    for (const linkedId of [draft.service_vendor_bill_id, draft.freight_vendor_bill_id, draft.tariff_vendor_bill_id]) {
      if (!linkedId) continue;
      const linked = (await knex.raw(
        `SELECT id, status FROM vendor_bill WHERE id = ? AND deleted_at IS NULL AND status = 'draft'`,
        [linkedId]
      )).rows as Array<{ id: string }>;
      if (linked[0]) linkedDraftIds.push(linked[0].id);
    }

    console.log(
      `${poNumber}: draft ${draft.id.slice(0, 18)}… → QB ${stub.qb_ref_number ?? "?"}@${stub.qb_txn_id?.slice(0, 12) ?? "?"}` +
        ` | ref=${refToUse ?? "MISSING"} | receipt=${firstReceiptId ? "ok" : "NONE"}` +
        ` | linked drafts to confirm first: ${linkedDraftIds.length} | lines sin CBM: ${cbmMissing.n}`
    );

    if (!apply) continue;

    if (!firstReceiptId) {
      console.log(`   ❌ no applied receipt — cannot confirm, skipped`);
      failures++;
      continue;
    }

    // 1. Reference enrichment (the QB bill's RefNumber is the vendor's real invoice #).
    if (!draft.reference_id?.trim() && stub.qb_ref_number) {
      await knex.raw(
        `UPDATE vendor_bill SET reference_id = ?, updated_at = NOW() WHERE id = ?`,
        [stub.qb_ref_number, draft.id]
      );
    }

    // 2. Confirm linked service/freight/tariff drafts first (pools).
    let linkedOk = true;
    for (const linkedId of linkedDraftIds) {
      const { res, result } = makeRes();
      await confirmLightPOST(
        makeReq({ id: linkedId }, {}) as never,
        res as never
      );
      const r = result();
      if (r.status !== 200) {
        console.log(`   ❌ linked draft ${linkedId.slice(0, 18)}… confirm failed ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
        linkedOk = false;
      }
    }
    if (!linkedOk) {
      failures++;
      continue;
    }

    // 3. Confirm the regular draft via the REAL route handler (in-process).
    const { res, result } = makeRes();
    await confirmRegularPOST(
      makeReq(
        { id: stub.purchase_order_id, receiptId: firstReceiptId },
        { vendor_bill_id: draft.id }
      ) as never,
      res as never
    );
    const r = result();
    if (r.status !== 200) {
      console.log(`   ❌ confirm failed ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
      failures++;
      continue;
    }

    // 4. Link the QB identity onto the confirmed bill + retire the stub.
    //    Dates (owner 2026-07-23): the bill takes the QB bill's LEGAL TxnDate;
    //    linked service/freight/tariff bills inherit the REGULAR's date.
    await knex.raw(
      `UPDATE vendor_bill
          SET qb_txn_id = ?, qb_ref_number = ?, qb_edit_sequence = ?,
              qb_synced_at = NOW(), qb_source = 'adopted', status = 'synced',
              document_date = COALESCE(?, document_date),
              updated_at = NOW()
        WHERE id = ?`,
      [stub.qb_txn_id, stub.qb_ref_number, stub.qb_edit_sequence, stub.document_date, draft.id]
    );
    if (stub.document_date && linkedDraftIds.length > 0) {
      await knex.raw(
        `UPDATE vendor_bill SET document_date = ?, updated_at = NOW() WHERE id = ANY(?)`,
        [stub.document_date, linkedDraftIds]
      );
    }
    await knex.raw(
      `UPDATE vendor_bill SET deleted_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [stub.id]
    );
    console.log(`   ✅ confirmed + linked (stub retired)`);
    confirmed++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`  confirmed+linked: ${confirmed}`);
  console.log(`  adopted POs without POS draft (stub stays): ${skippedNoDraft}`);
  console.log(`  failures/skips: ${failures}`);
  if (!apply) console.log(`\nDRY RUN — pass "apply" to execute.`);
}
