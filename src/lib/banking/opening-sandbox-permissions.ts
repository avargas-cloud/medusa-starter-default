/** Root-owned v10 harness invokes this only after sandbox snapshot and scope preflight. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { POS_USER_MODULE } from "../../modules/pos-user";
import { GET as detailRoute } from "../../api/admin/banking/accounting/openings/[id]/route";
import { GET as evidenceRoute } from "../../api/admin/banking/accounting/openings/evidence/[id]/route";
import { POST as previewRoute } from "../../api/admin/banking/accounting/openings/[id]/preview/route";
import { POST as adoptRoute } from "../../api/admin/banking/accounting/openings/[id]/adopt/route";
import { POST as revokeRoute } from "../../api/admin/banking/accounting/openings/[id]/revoke/route";
import { POST as clearRoute } from "../../api/admin/banking/accounting/openings/items/[id]/clear/route";
import { POST as unclearRoute } from "../../api/admin/banking/accounting/openings/items/[id]/unclear/route";
import { actor, rootPrefix } from "../../scripts/tests/bank-receipts-fixtures";
import { openingPrefix } from "../../scripts/tests/bank-openings-fixtures";
import { OpeningSandboxApi, type TestValue } from "./opening-sandbox-api";
import { requireBankingSandbox } from "./security";
import { transaction } from "./store";
import { withReviewLock } from "./review-common";

type Input = { client: PoolClient; test: OpeningSandboxApi; bankOpeningId: string; ufOpeningId: string;
  itemId: string; transactionId: string; draftOpeningId?: string };

export async function runOpeningPermissions({ client, test, bankOpeningId, ufOpeningId,
  itemId, transactionId, draftOpeningId }: Input): Promise<void> {
  requireBankingSandbox();
  const baseline = (await client.query(`SELECT id,reference,books_evidence_id,revision FROM bank_opening_balance
    WHERE id=ANY($1::text[]) ORDER BY id`, [[bankOpeningId, ufOpeningId]])).rows;
  assert(baseline.length === 2 && baseline.every(row => String(row.reference).startsWith(openingPrefix)), "Only owned opening fixtures");
  assert(transactionId.startsWith(rootPrefix));
  assert((await client.query("SELECT 1 FROM bank_opening_item WHERE id=$1 AND opening_id=$2", [itemId, bankOpeningId])).rowCount);
  const ledgerCounts = async () => (await client.query(`SELECT (SELECT count(*)::text FROM bank_journal_entry) AS entries,
    (SELECT count(*)::text FROM bank_journal_line) AS lines,(SELECT count(*)::text FROM bank_receipt_consumption) AS consumption`)).rows[0];
  const ledgerBefore = await ledgerCounts();
  const staff = actor + "_opening_staff", permissionId = rootPrefix + "opening_permission";
  let accountingVisible = true;
  await transaction(client, async () => {
    await withReviewLock(client);
    assert((await client.query("SELECT count(*)::int n FROM bank_review_permission")).rows[0].n < 25);
    await client.query(`INSERT INTO bank_review_permission(id,user_id,can_review,can_close,can_post,granted_by)
      VALUES($1,$2,true,true,false,$3)`, [permissionId, staff, actor]);
  });
  const permission = async (canPost: boolean, reviewAndClose: boolean) => transaction(client, async () => {
    await withReviewLock(client);
    const changed = await client.query(`UPDATE bank_review_permission SET can_post=$2,can_review=$3,can_close=$3
      WHERE id=$1 AND user_id=$4`, [permissionId, canPost, reviewAndClose, staff]);
    assert(changed.rowCount === 1, "Only the owned permission was changed");
  });
  const call = async (route: typeof detailRoute, id: string, body: TestValue = {}): Promise<{
    status: number; result: TestValue; bytes: Buffer | null; headers: Map<string, string>;
  }> => {
    const req = { auth_context: { actor_id: staff }, params: { id }, body, headers: { "idempotency-key": randomUUID() },
      scope: { resolve: (name: string) => {
        if (name === "user") return { retrieveUser: async () => ({ email: "openings-v10-staff@example.invalid" }) };
        if (name === POS_USER_MODULE) return { listPosUsers: async () => [{ can_view_accounting: accountingVisible }] };
        throw new Error(`Unexpected opening route dependency ${name}`);
      } } } as unknown as AuthenticatedMedusaRequest;
    let status = 200, result: TestValue = {}, bytes: Buffer | null = null;
    const headers = new Map<string, string>();
    const res = { status: (value: number) => { status = value; return res; },
      json: (value: TestValue) => { result = value; return res; },
      setHeader: (name: string, value: string) => { headers.set(name.toLowerCase(), value); return res; },
      set: (name: string, value: string) => { headers.set(name.toLowerCase(), value); return res; },
      send: (value: Buffer) => { bytes = value; return res; }, end: (value?: Buffer) => { bytes = value ?? null; return res; } };
    await route(req, res as unknown as MedusaResponse);
    return { status, result, bytes, headers };
  };
  const cases = [
    ["preview", previewRoute, bankOpeningId, { expected_revision: 2 }],
    ["adopt", adoptRoute, ufOpeningId, { expected_revision: 2, preview_hash: "a".repeat(64), evidence_attested: true }],
    ["revoke", revokeRoute, bankOpeningId, { expected_revision: 2, reason: "Must be rejected before any state mutation" }],
    ["clear", clearRoute, itemId, { transaction_id: transactionId, expected_source_version: 1, expected_item_hash: "a".repeat(64) }],
    ["unclear", unclearRoute, itemId, { clear_id: rootPrefix + "permission_clear", reason: "Must remain rejected" }],
  ] as const;
  for (const [label, route, id, body] of cases) {
    const denied = await call(route, id, body);
    test.check(denied.status === 403 && denied.result.code === "BANKING_ACCESS_DENIED",
      `Opening ${label} rejects can_review/can_close without can_post before validating state`);
  }
  accountingVisible = false;
  await permission(false, false);
  const evidenceId = String(baseline.find(row => row.id === bankOpeningId)!.books_evidence_id);
  for (const [label, route, id] of [["detail", detailRoute, bankOpeningId], ["private evidence", evidenceRoute, evidenceId]] as const) {
    const denied = await call(route, id);
    test.check(denied.status === 403 && denied.result.code === "BANKING_ACCESS_DENIED", `Opening ${label} denies staff with no banking/accounting access`);
  }
  await permission(true, false);
  const allowed = await call(detailRoute, bankOpeningId);
  test.check(allowed.status === 200 && (allowed.result.opening as TestValue)?.id === bankOpeningId,
    "Delegated can_post alone permits reading the actual opening");
  const evidence = await call(evidenceRoute, evidenceId);
  test.check(evidence.status === 200 && Buffer.isBuffer(evidence.bytes) && evidence.bytes.subarray(0, 5).toString() === "%PDF-",
    "Delegated can_post alone reads the actual private PDF bytes");
  if (draftOpeningId) {
    const draft = (await client.query("SELECT revision,status FROM bank_opening_balance WHERE id=$1", [draftOpeningId])).rows[0];
    assert(draft?.status === "draft");
    const preview = await call(previewRoute, draftOpeningId, { expected_revision: draft.revision });
    // This is a positive authorization test only when it reaches a successful real preview.
    test.check(preview.status === 200 && /^[a-f0-9]{64}$/.test(String(preview.result.preview_hash)),
      `Delegated can_post executes a valid draft preview (status=${preview.status}, code=${String(preview.result.code ?? "ok")})`);
  }
  assert.deepEqual(await ledgerCounts(), ledgerBefore, "Permission probes and previews create zero journal/consumption rows");
  test.check(true, "Opening permission verification leaves the ledger unchanged");
}
